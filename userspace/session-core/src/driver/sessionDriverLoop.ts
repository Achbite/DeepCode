import type {
  AgentContextAttachment,
  AgentConversationActivity,
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
  KernelToolCatalogSnapshot,
  KernelToolCatalogTool,
} from '@deepcode/protocol';
import { listDefaultAgentTools } from '@deepcode/protocol';
import { parseProposalEnvelope } from '../agent-plan/protocolV3.js';
import { actionBundleProtocolShapeLines, actionBundleProtocolShapeReference, resourceRequestProtocolShapeLine } from '../agent-plan/protocolContract.js';
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
  type ProjectMemoryMode,
  type SessionMemoryDocument,
  type UserGuidanceEvent,
} from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type { RequirementChecklist, RequirementRecord } from '../requirement/types.js';
import type { TranscriptEntry } from '../transcript.js';
import {
  buildAcceptedPlanPromptFrame,
  buildAnswerFactsContext,
  buildReviewFactsContext,
  buildTaskLedgerSnapshot,
  evaluateRunState,
  normalizeDecisionEffect,
  type AcceptedPlanPromptFrame,
  type TaskLedgerSnapshot,
} from '../run-state/index.js';
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
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
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
  projectMemoryMode?: ProjectMemoryMode;
  interactionOverlay?: InteractionOverlayContext;
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
  generatedArtifactEvidence: Map<string, GeneratedArtifactEvidence>;
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  implementationBatch: ImplementationBatchContext;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  resourceRequestRepairAttempted: boolean;
  actionBundleAdmissionRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
  acceptedPlanScopeRepairAttempted: boolean;
  terminalGuidanceRevisionAttempted: boolean;
  nativeToolReadLedger: Map<string, NativeToolReadLedgerEntry>;
  nativeToolDuplicateRepairAttempted: boolean;
  activeTurn?: ActiveTurnState;
  interactionOverlay?: InteractionOverlayContext;
}

interface GeneratedArtifactEvidence {
  targetPath: string;
  content: string;
  contentHash: string;
  manifestEntryId: string;
  sourceBlockId?: string;
  actionId?: string;
  workUnitId?: string;
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

interface InteractionOverlayContext {
  parentRunId: string;
  parentPhase: SessionTurnPhase;
  interactionRunId: string;
  interactionId: string;
  sourceInteractionId?: string;
  resumedFromDecisionId?: string;
  acceptedPlanId?: string;
  acceptedPlanRunId?: string;
  acceptedCurrentTaskId?: string;
  acceptedCompletedTaskIds?: string[];
}

interface ImplementationBatchContext {
  batchIndex: number;
  recentPlanSummaries: string[];
  continuationSummaries: string[];
}

interface TaskExecutionCursor {
  cursorId: string;
  planId?: string;
  currentTaskId?: string;
  taskOrder: string[];
  pendingTaskIds: string[];
  completedTaskIds: string[];
  lastResourcePacketIds: string[];
  lastSavepointId?: string;
}

interface CurrentTaskContext {
  goal: string;
  taskId?: string;
  nodeId?: string;
  taskTitle?: string;
  targets: string[];
  capabilities: string[];
  taskOrder: string[];
  pendingTaskIds: string[];
  dependsOn: string[];
  evidenceNeeds: string[];
  completedTaskIds: string[];
}

interface AcceptedImplementationPlanTaskContext {
  taskId: string;
  title?: string;
  capability?: string;
  targets: string[];
  dependencies: string[];
  conflictKeys: string[];
  batchKind?: ExecutionSliceRole;
  role?: ExecutionSliceRole;
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
  exactOperationGrants: AcceptedPlanExactOperationGrant[];
  accessScopes: AcceptedPlanAccessScope[];
  executionRoot?: AcceptedImplementationPlanExecutionRoot;
  interventionLevel?: InterventionLevel;
  batchIndex: number;
  completedTaskIds: string[];
  rawPlan: Record<string, unknown>;
}

type ExecutionSliceRole = 'sourceCode' | 'infra' | 'script' | 'test' | 'docs' | 'config' | 'review';

interface StaticSyntaxReviewPacket {
  planId: string;
  files: Array<{
    targetPath: string;
    language?: string;
    content: string;
    contentHash?: string;
  }>;
}

interface AcceptedPlanBatchValidationResult {
  ok: boolean;
  reasons: string[];
}

interface AcceptedPlanAccessScopeCanonicalizationResult {
  proposal: ProposalEnvelope;
  changed: boolean;
  removedAccessScopes: RemovedAcceptedPlanAccessScope[];
  actionTargets: string[];
}

interface RemovedAcceptedPlanAccessScope {
  index: number;
  reason: string;
  source: string;
  path?: string;
  scopeKind?: string;
  scope: unknown;
}

interface AcceptedPlanTargetScope {
  raw: string;
  normalized: string;
}

interface AcceptedPlanAccessScope {
  scopeKind: string;
  path: string;
  capabilities: string[];
  operations: string[];
  reason?: string;
  dependencyDepth?: number;
  sourceTaskId?: string;
  outsideWorkspace?: boolean;
  source: 'kernelPlanReview' | 'implementationPlan';
}

interface AcceptedPlanExactOperationGrant {
  operation: string;
  targetPath: string;
  targetRefPath?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  capability: string;
  actionId?: string;
  sourceTaskId?: string;
  outsideWorkspace?: boolean;
  source: 'kernelPlanReview' | 'implementationPlan';
}

interface AcceptedPlanBatchProgress {
  actionIds: string[];
  targetPaths: string[];
  workUnitIds: string[];
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
}

interface AcceptedPlanReadOnlyResourceCompletion {
  taskId: string;
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
  coveredTargets: string[];
}

type SessionRunStateStatus = 'waiting' | 'running' | 'completed' | 'cancelled' | 'failed';

type SessionRunStateReason =
  | 'requirement'
  | 'plan_review'
  | 'permission'
  | 'review'
  | 'accepted_plan_execution'
  | 'work_unit_failed';

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
  providerJsonStreamProgress?: Record<string, {
    receivedChars: number;
    lastEmittedChars: number;
  }>;
}

interface NativeToolCallProposal {
  callId: string;
  index: number;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

interface NativeToolReadSignature {
  key: string;
  toolName: string;
  path: string;
  rootId?: string;
  offsetBytes?: number;
  limitBytes?: number;
}

interface NativeToolReadLedgerEntry {
  signature: NativeToolReadSignature;
  packet: ResourcePacket;
  contentHash: string;
  repeatCount: number;
}

interface ProviderToolCallBufferItem {
  callId?: string;
  name?: string;
  argumentsText: string;
}

interface ProviderReasoningDeltaBuffer {
  pending: string;
  lastFlushAt: number;
  itemId?: string;
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
const MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 384 * 1024;
const DEFAULT_SUB_AGENT_NO_DELTA_TIMEOUT_MS = 45_000;
const DEFAULT_SUB_AGENT_TOTAL_TIMEOUT_MS = 240_000;
const NATIVE_TOOL_RESULT_MAX_CHARS = 12 * 1024;
const PROVIDER_REASONING_FLUSH_CHARS = 768;
const PROVIDER_REASONING_FLUSH_MS = 120;
const SIDE_EFFECT_CAPABILITIES = new Set([
  'fs.write',
  'fs.patch',
  'fs.delete',
  'fs.rename',
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
        diag('decisionResolverMissing', `Decision kind "${input.kind}" is not yet connected to Session DecisionResolver.`, { kind: input.kind }),
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
    const memoryDocument = buildSessionMemoryDocument(input.existingEvents ?? [], {
      projectMemoryMode: input.projectMemoryMode,
    });
    const restoredResourcePackets = input.resumeResourcePackets
      ? recentResourcePackets(input.existingEvents ?? [])
      : [];
    const initialTaskCursor = buildTaskExecutionCursor(
      acceptedImplementationPlan,
      restoredResourcePackets,
      lastAcceptedPlanTaskSavepointId(input.existingEvents ?? [])
    );
    const initialTaskContext = buildCurrentTaskContext(acceptedImplementationPlan, initialTaskCursor);
    const initialTaskLedger = buildAcceptedPlanTaskLedger(acceptedImplementationPlan);
    const initialAcceptedPlanPromptFrame = buildAcceptedPlanPromptFrameForContext(acceptedImplementationPlan, initialTaskLedger);
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
      generatedArtifactEvidence: generatedArtifactEvidenceFromPackets(restoredResourcePackets),
      memoryDocument,
      memoryHints: implementationBatchHints(implementationBatch, acceptedImplementationPlan),
      taskExecutionCursor: initialTaskCursor,
      currentTaskContext: initialTaskContext,
      taskLedger: initialTaskLedger,
      acceptedPlanPromptFrame: initialAcceptedPlanPromptFrame,
      implementationBatch,
      acceptedImplementationPlan,
      resourceRequestRepairAttempted: false,
      actionBundleAdmissionRepairAttempted: false,
      planReviewRepairAttempted: false,
      acceptedPlanScopeRepairAttempted: false,
      terminalGuidanceRevisionAttempted: false,
      nativeToolReadLedger: new Map(),
      nativeToolDuplicateRepairAttempted: false,
      interactionOverlay: input.interactionOverlay,
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
            diag('requirementConfirmationFailed', `Requirement confirmation generation failed: ${message}`, { message }),
            this.ts(),
            this.id('requirement-confirmation-failed')
          ),
        ]);
      }
    }

    while (true) {
      refreshTaskExecutionState(state);
      const assembledContext = assembleContext({
        contextAssemblyId: this.id('context-assembly'),
        workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
        allowedProposals: sessionProviderAllowedProposals(state.stateContract?.allowedProposals ?? [
          'answer',
          'resourceRequest',
          'decisionRequest',
          'taskPlan',
          'actionBundle',
          'diagnostic',
        ], state),
        capabilityCatalogSummary: capabilityCatalogSummaryForState(state),
        memoryDocument: state.memoryDocument,
        projectMemoryMode: input.projectMemoryMode,
        extraMemoryHints: [
          ...currentTaskMemoryHints(state.currentTaskContext),
          ...implementationBatchHints(state.implementationBatch, state.acceptedImplementationPlan),
        ],
        interventionLevel: input.interventionLevel,
        userGuidance: collectUserGuidanceEvents(lastResult.events, state.runId),
        userRequest: input.content,
        currentTaskGoal: state.currentTaskContext?.goal,
        currentTaskContext: state.currentTaskContext,
        taskCursor: state.taskExecutionCursor,
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
              readableDriverFailureMessage(error.code, error.message),
              this.ts(),
              this.id(error.code)
            ),
          ]);
        }
        // S5：provider 流式连接中断（undici "terminated"）、网络抖动、provider 超时等
        // 原始错误不属于协议错误，过去会直接抛出成裸错误终止整轮；此处统一降级为可读、
        // 可恢复的诊断，不影响此前已完成步骤。
        return this.append(sessionId, [
          finalDiagnosticEvent(
            sessionId,
            readableProviderFailureMessage(error),
            this.ts(),
            this.id('provider_call_failed')
          ),
        ]);
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
        const interactionOverlay: InteractionOverlayContext = {
          parentRunId: state.interactionOverlay?.parentRunId ?? state.runId,
          parentPhase: state.phase,
          interactionRunId: state.runId,
          interactionId: requirement.requirementId,
          sourceInteractionId: requirement.requirementId,
          acceptedPlanId: state.acceptedImplementationPlan?.planId,
          acceptedPlanRunId: state.acceptedImplementationPlan?.runId,
          acceptedCurrentTaskId: state.currentTaskContext?.taskId,
          acceptedCompletedTaskIds: state.acceptedImplementationPlan?.completedTaskIds,
        };
        const confirmation = requirementConfirmationEvent({
            sessionId,
            runId: state.runId,
            requirement,
            proposal,
            originalUserRequest: input.content,
            attachments: input.attachments ?? [],
            interactionOverlay,
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
            interactionOverlay,
            ts: this.ts(),
            id: this.id('session-run-waiting-requirement'),
          }),
        ]);
      }
      if (proposal.kind === 'diagnostic') {
        const diagnostic = objectRecord(proposal.payload) ?? {};
        const summary = stringValue(diagnostic.summary)
          ?? stringValue(diagnostic.details)
          ?? 'The model returned diagnostic information without generating a plan or execution queue.';
        return this.append(sessionId, [
          finalDiagnosticEvent(sessionId, summary, this.ts(), this.id('diagnostic')),
        ]);
      }
      if (proposal.kind === 'taskPlan' || proposal.kind === 'implementationPlan') {
        const planId = stringValue(objectRecord(proposal.payload)?.id) ?? proposal.proposalId;
        state.phase = 'waiting_plan_review';
        return this.append(sessionId, [
          implementationPlanCardEvent(state, proposal, this.ts(), this.id('task-plan')),
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
        const generated = generatedArtifactResourcePacketForRequest(
          state,
          proposal.payload as ResourceRequestDraft,
          this.id('generated-artifact-resource')
        );
        if (generated.packet) {
          state.resourcePackets.push(generated.packet);
          lastResult = await this.append(sessionId, [resourcePacketEvent(sessionId, generated.packet, this.ts(), this.id('generated-artifact-resource-context'))]);
          if (!generated.remaining.items.length) continue;
        }
        let subset = manifestForResourceRequest(state.manifest, generated.remaining, state.conversationRoots);
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
                  diag('resourceResolveRepairFailed', `The requested resources could not be located in attachments or project directory, and repair failed: ${message}`, { message }),
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
        if (state.acceptedImplementationPlan) {
          refreshTaskExecutionState(state);
          const resumeEvent = acceptedPlanResourceResumeEvent(
            sessionId,
            state.runId,
            state.acceptedImplementationPlan,
            state.taskExecutionCursor,
            state.currentTaskContext,
            packet,
            this.ts(),
            this.id('accepted-plan-resource-resume')
          );
          lastResult = await this.append(sessionId, [resumeEvent]) ?? lastResult;
          const readOnlyCompletion = await this.tryCompleteAcceptedPlanReadOnlyResourceTask(
            input,
            state,
            packet,
            lastResult
          );
          if (readOnlyCompletion) return readOnlyCompletion;
          const resumed = await this.callAcceptedPlanResourceResume(input, state, prompt, proposal, packet);
          if (resumed.kind === 'actionBundle') {
            return this.submitActionProposal(input, state, prompt, resumed, lastResult);
          }
          if (resumed.kind !== 'resourceRequest') {
            return this.submitNonExecutableProposal(state, resumed, lastResult);
          }
        }
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
    const interactionOverlay = interactionOverlayFromRequirementDecision(confirmation, decisionEvent);
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
          interactionOverlay,
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
        projectMemoryMode: input.projectMemoryMode,
        interventionLevel: input.interventionLevel,
        resumeResourcePackets: true,
        interactionOverlay,
      });
    }
    if (isAcceptedPlanScopeConfirmation(confirmation)) {
      return this.resolveAcceptedPlanScopeRequirementDecision(input, confirmation, decisionEvent, interactionOverlay, result);
    }
    if (isAcceptedPlanExecutionConfirmation(confirmation)) {
      return this.resolveAcceptedPlanExecutionRequirementDecision(input, confirmation, decisionEvent, interactionOverlay, result);
    }

    // R2 状态机派发：如果用户接受的 option 携带 effect 合约，按其声明推进状态机，
    // 不再让模型重新猜测。这是"卡片所读即事实"的兜底：选项已显式声明副作用，
    // 系统据此产事实事件，避免模型再次伪造任务完成。
    if (input.decision === 'accept') {
      const optionEffect = selectedRequirementDecisionOptionEffect(decisionEvent);
      if (optionEffect) {
        const dispatched = await this.applyRequirementOptionEffect(
          input,
          confirmation,
          decisionEvent,
          interactionOverlay,
          optionEffect,
          result
        );
        if (dispatched) return dispatched;
      }
    }

    const originalRequest = requirementDecisionResumeRequest(confirmation, decisionEvent, input.decision, input.guidance);
    const next = await this.runUserTurn({
      sessionId: input.sessionId,
      content: originalRequest,
      attachments: requirementAttachments(confirmation),
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectMemoryMode: input.projectMemoryMode,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      confirmedRequirement: input.decision === 'accept' ? requirementRecordFromEvent(confirmation, 'confirmed') : undefined,
      requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
      interventionLevel: input.interventionLevel,
      interactionOverlay,
    });

    return next;
  }

  private async resolveAcceptedPlanScopeRequirementDecision(
    input: SessionDecisionResolverInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const decisionRequest = objectRecord(confirmationPayload.decisionRequest) ?? {};
    const runId = stringValue(confirmationPayload.runId) ?? input.runId;
    const planId = stringValue(decisionRequest.acceptedPlanId);
    const selectedOptionId = selectedRequirementDecisionOptionId(decisionEvent);
    const plan = (runId ? findPlanCard(current.events, runId, planId) : null)
      ?? findPlanCard(current.events, undefined, planId)
      ?? (runId ? latestExecutablePlan(current.events, runId) : null);

    if (input.decision === 'revise' || selectedOptionId === 'revise-plan') {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: acceptedPlanScopeRevisionRequest(confirmation, plan, input.guidance),
        attachments: requirementAttachments(confirmation),
        existingEvents: current.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
        interactionOverlay,
      });
    }

    if (!plan || !plan.implementationPlan) {
      return this.append(input.sessionId, [
        finalDiagnosticEvent(
          input.sessionId,
          'Accepted-plan scope decision could not recover the original implementationPlan; Session will not start a detached requirement flow.',
          this.ts(),
          this.id('accepted-plan-scope-decision-missing-plan')
        ),
      ]) ?? current;
    }

    const executionRoot = acceptedPlanExecutionRootFromDecision(input, current.events);
    const acceptedPlan = acceptedPlanWithLatestCheckpoint(
      acceptedImplementationPlanContext(plan, input.interventionLevel, executionRoot),
      current.events
    );
    const selectedEffect = selectedRequirementDecisionOptionEffect(decisionEvent);
    const nextAcceptedPlan = acceptedPlanWithScopeDecisionEffect(acceptedPlan, selectedEffect);
    const guidance = input.guidance?.trim()
      ? `用户对 accepted-plan scope 介入的补充意见：${input.guidance.trim()}`
      : acceptedPlanScopeDecisionResumeGuidance(selectedEffect);
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: implementationPlanExecutionRequest(plan, nextAcceptedPlan, guidance),
      attachments: nextAcceptedPlan.executionRoot ? [nextAcceptedPlan.executionRoot.attachment] : requirementAttachments(confirmation),
      existingEvents: current.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      requirementConfirmationMode: 'off',
      reviewContinuationMode: input.reviewContinuationMode,
      interventionLevel: input.interventionLevel,
      projectMemoryMode: input.projectMemoryMode,
      resumeResourcePackets: true,
      acceptedImplementationPlan: nextAcceptedPlan,
      interactionOverlay,
    });
  }

  // R2 effect 派发：按用户选定 option 的 effect 合约推进状态机，
  // 通过产 workflow_stage(stage=accepted_plan.batch_checkpoint, source=requirementDecision) 事件
  // 复用现有"completedTaskIds 推进"机制——状态由事实事件驱动，GUI 所读即事实。
  // 返回 undefined 表示降级到默认的 runUserTurn 路径（continueWithAction 或缺少 acceptedPlan 上下文）。
  private async applyRequirementOptionEffect(
    input: SessionDecisionResolverInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    effect: RequirementOptionEffect,
    current: AgentSessionResult
  ): Promise<AgentSessionResult | undefined> {
    const normalizedEffect = normalizeDecisionEffect(effect);
    const stateDecision = evaluateRunState({ decisionEffect: normalizedEffect });
    if (stateDecision.kind === 'continueAcceptedPlan') return undefined;

    const decisionPayload = objectRecord(decisionEvent.payload) ?? {};
    const runId = stringValue(decisionPayload.runId) ?? input.runId ?? 'run-unknown';
    const requirementId = stringValue(decisionPayload.requirementId) ?? input.targetId;
    const baseOwner = {
      kind: 'requirement' as const,
      runId,
      targetId: requirementId,
      requirementId,
    };

    if (stateDecision.kind === 'finishWithAnswer') {
      return this.append(input.sessionId, [
        answerEvent(input.sessionId, answerProposalFromDecisionEffect(
          input.sessionId,
          runId,
          effect,
          current.events,
          input.guidance,
          this.id('finish-with-answer-proposal')
        ), this.ts(), this.id('answer'), {
          answerFactsContext: buildAnswerFactsContext({
            reviewFactsContext: buildReviewFactsContext({
              runId,
              taskLedger: buildAcceptedPlanTaskLedger(this.recoverAcceptedPlanForRequirement(current.events, runId, undefined)),
            }),
            userGuidance: input.guidance,
          }),
        }),
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'completed',
          status: 'completed',
          reason: 'requirement',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-completed-answer'),
        }),
      ]) ?? current;
    }

    if (stateDecision.kind === 'cancel') {
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'completed',
          status: 'completed',
          reason: 'requirement',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-completed-requirement'),
        }),
      ]) ?? current;
    }

    if (stateDecision.kind === 'waitForPlanReview') {
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'waiting_plan_review',
          status: 'waiting',
          reason: 'plan_review',
          decisionOwner: baseOwner,
          interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-replan-requirement'),
        }),
      ]) ?? current;
    }

    // skipTask / markAcceptedIncomplete：必须有 acceptedImplementationPlan 上下文。
    const confirmationPayload = objectRecord(confirmation.payload) ?? {};
    const decisionRequest = objectRecord(confirmationPayload.decisionRequest) ?? {};
    const planId = stringValue(decisionRequest.acceptedPlanId)
      ?? stringValue(confirmationPayload.acceptedPlanId)
      ?? stringValue(decisionPayload.acceptedPlanId);
    const accepted = this.recoverAcceptedPlanForRequirement(current.events, runId, planId);
    if (!accepted) return undefined;

    const currentCompleted = new Set(accepted.completedTaskIds);
    const currentTaskId = accepted.tasks.find((task) => !currentCompleted.has(task.taskId))?.taskId;
    const newlyCompleted: string[] = [];
    let acceptedIncompleteTaskIds: string[] = [];
    if (normalizedEffect.kind === 'skipTask') {
      if (!currentTaskId) return undefined;
      newlyCompleted.push(currentTaskId);
    } else if (normalizedEffect.kind === 'markAcceptedIncomplete') {
      const ids = normalizedEffect.taskIds?.length ? normalizedEffect.taskIds : (currentTaskId ? [currentTaskId] : []);
      acceptedIncompleteTaskIds = ids.filter((id) => !currentCompleted.has(id) && accepted.tasks.some((task) => task.taskId === id));
      newlyCompleted.push(...acceptedIncompleteTaskIds);
      if (newlyCompleted.length === 0) return undefined;
    } else {
      return undefined;
    }
    const mergedCompletedTaskIds = [...accepted.completedTaskIds, ...newlyCompleted];
    const nextAccepted = acceptedPlanAfterBatch(accepted, mergedCompletedTaskIds);
    const remainingTaskIds = accepted.tasks
      .map((task) => task.taskId)
      .filter((id) => !mergedCompletedTaskIds.includes(id));
    const allDone = remainingTaskIds.length === 0;

    const checkpointId = this.id('requirement-driven-task-checkpoint');
    const events: AgentEvent[] = [
      requirementDrivenTaskCheckpointEvent(
        input.sessionId,
        runId,
        nextAccepted,
        newlyCompleted,
        mergedCompletedTaskIds,
        remainingTaskIds,
        effect.kind,
        stringValue(objectRecord(decisionPayload.selectedOption)?.id),
        this.ts(),
        checkpointId
      ),
    ];
    if (allDone) {
      events.push(sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'completed',
        status: 'completed',
        reason: 'requirement',
        decisionOwner: baseOwner,
        interactionOverlay,
        ts: this.ts(),
        id: this.id('session-run-completed-requirement-tasks'),
      }));
      return this.append(input.sessionId, events) ?? current;
    }

    // 尚有剩余任务：以更新后的 acceptedImplementationPlan 继续 runUserTurn
    const result = await this.append(input.sessionId, events) ?? current;
    const originalRequest = requirementDecisionResumeRequest(confirmation, decisionEvent, input.decision, input.guidance);
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: originalRequest,
      attachments: requirementAttachments(confirmation),
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectMemoryMode: input.projectMemoryMode,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      confirmedRequirement: requirementRecordFromEvent(confirmation, 'confirmed'),
      requirementConfirmationMode: 'off',
      interventionLevel: input.interventionLevel,
      acceptedImplementationPlan: nextAccepted,
      interactionOverlay,
    });
  }

  // 从既有 events 中恢复 acceptedImplementationPlan：先找 plan_card+implementationPlan，再叠加最新 checkpoint。
  private recoverAcceptedPlanForRequirement(
    events: AgentEvent[],
    runId: string,
    planId: string | undefined
  ): AcceptedImplementationPlanContext | undefined {
    const plan = (runId ? findPlanCard(events, runId, planId) : null)
      ?? findPlanCard(events, undefined, planId)
      ?? (runId ? latestExecutablePlan(events, runId) : null);
    if (!plan || !plan.implementationPlan) return undefined;
    const base = acceptedImplementationPlanContext(plan, undefined, undefined);
    return acceptedPlanWithLatestCheckpoint(base, events);
  }

  private async resolveAcceptedPlanExecutionRequirementDecision(
    input: SessionDecisionResolverInput,
    confirmation: AgentEvent,
    decisionEvent: AgentEvent,
    interactionOverlay: InteractionOverlayContext | undefined,
    current: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const acceptedContext = recoverAcceptedPlanFromOverlay(input, current.events, interactionOverlay);
    if (!acceptedContext) {
      return this.append(input.sessionId, [
        finalDiagnosticEvent(
          input.sessionId,
          'Accepted-plan interaction decision could not recover the parent implementationPlan; Session will not start a detached requirement flow.',
          this.ts(),
          this.id('accepted-plan-interaction-missing-plan')
        ),
      ]) ?? current;
    }
    const guidance = acceptedPlanExecutionRequirementResumeRequest(
      confirmation,
      decisionEvent,
      input.decision,
      input.guidance
    );
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: implementationPlanExecutionRequest(acceptedContext.plan, acceptedContext.acceptedPlan, guidance),
      attachments: acceptedContext.acceptedPlan.executionRoot
        ? [acceptedContext.acceptedPlan.executionRoot.attachment]
        : requirementAttachments(confirmation),
      existingEvents: current.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
      reviewContinuationMode: input.reviewContinuationMode,
      interventionLevel: input.interventionLevel,
      projectMemoryMode: input.projectMemoryMode,
      resumeResourcePackets: true,
      acceptedImplementationPlan: acceptedContext.acceptedPlan,
      interactionOverlay,
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
      if (input.decision === 'revise') {
        return this.runUserTurn({
          sessionId: input.sessionId,
          content: planRevisionRequest(plan, input.guidance),
          attachments: [],
          existingEvents: result.events,
          workspaceBinding: input.workspaceBinding,
          projectWorkingDirectory: input.projectWorkingDirectory,
          profileId: input.profileId,
          workflow: input.workflow,
          appendUserMessage: false,
          requirementConfirmationMode: 'off',
          reviewContinuationMode: input.reviewContinuationMode,
          interventionLevel: input.interventionLevel,
          projectMemoryMode: input.projectMemoryMode,
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
        });
      }
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
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
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
        projectMemoryMode: input.projectMemoryMode,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        resumeResourcePackets: true,
        acceptedImplementationPlan: acceptedPlan,
        interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
      });
    }
    const acceptedOverlay = recoverAcceptedPlanFromOverlay(input, result.events, plan.interactionOverlay ?? input.interactionOverlay);
    return this.executeAcceptedActionBundlePlan(input, plan, result, acceptedOverlay);
  }

  private async executeAcceptedActionBundlePlan(
    input: SessionDecisionResolverInput,
    plan: SessionPlanContext,
    initialResult: AgentSessionResult,
    acceptedOverlay?: RecoveredAcceptedPlanContext
  ): Promise<AgentSessionResult> {
    let result = initialResult;
    try {
      result = await this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: plan.runId,
          phase: 'executing_accepted_plan',
          status: 'running',
          reason: 'accepted_plan_execution',
          decisionOwner: {
            kind: 'plan',
            runId: plan.runId,
            targetId: plan.planId,
            planId: plan.planId,
          },
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-accepted-action-plan-execution'),
        }),
      ]) ?? result;
      const batch: Record<string, unknown> = {
        planId: plan.planId,
        contractId: kernelExecutionContractId(plan.planReviewReport),
        actionBundle: plan.actionBundle,
        codeBlocks: plan.codeBlocks,
        commandBlocks: plan.commandBlocks,
      };
      result = await this.append(input.sessionId, [
        acceptedPlanActionBatchPreflightEvent(
          input.sessionId,
          plan,
          batch,
          this.ts(),
          this.id('accepted-action-plan-preflight')
        ),
      ]) ?? result;
      const deletePreflightReasons = acceptedPlanDeletePreflightReasons(batch, recentResourcePackets(result.events));
      if (deletePreflightReasons.length) {
        return this.append(input.sessionId, planActionBundlePreflightFailureEvents(
          input.sessionId,
          plan,
          deletePreflightReasons,
          this.ts(),
          this.id('accepted-action-plan-preflight-failed')
        )) ?? result;
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
      assertKernelReplyOk(decisionReply, 'accepted_plan_user_decision_failed', 'Kernel plan decision submit failed');
      result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply) ?? result;

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
        assertKernelReplyOk(grantReply, 'accepted_plan_grant_failed', 'Kernel temporary grant failed');
        grantEvents.push(...(grantReply.events ?? []));
      }
      if (grantEvents.length) {
        result = await this.appendProjectedKernelEvents(input.sessionId, { ok: true, events: grantEvents }) ?? result;
      }

      const batchReply = await this.kernel({
        command: {
          kind: 'actionBatchSubmit',
          requestId: this.id('action-batch-submit'),
          runId: plan.runId,
          sessionId: input.sessionId,
          batch,
        },
      });
      result = await this.appendProjectedKernelEvents(input.sessionId, batchReply) ?? result;
      const batchEvents = batchReply.events ?? [];
      if (!batchReply.ok && batchEvents.length === 0) {
        throw new SessionDriverLoopError(
          'accepted_plan_action_batch_submit_failed',
          kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed without execution facts')
        );
      }
      if (actionBatchHasFailureOrBlocker(batchEvents)) {
        return this.append(input.sessionId, planActionBundleExecutionFailureEvents(
          input.sessionId,
          plan,
          batchEvents,
          batch,
          this.ts(),
          this.id('accepted-action-plan-batch-failed')
        )) ?? result;
      }
      if (!actionBatchReadyForReview(batchEvents)) {
        if (kernelEventsContainPermissionRequest(batchEvents)) {
          const permissionId = permissionIdFromKernelEvents(batchEvents);
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
              interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
              ts: this.ts(),
              id: this.id('session-run-waiting-permission'),
            }),
          ]) ?? result;
        }
        return result;
      }
      if (acceptedOverlay) {
        const progressProposal = proposalEnvelopeFromPlanContext(plan);
        const progress = acceptedPlanBatchProgress(acceptedOverlay.acceptedPlan, progressProposal, batchEvents);
        const nextAccepted = acceptedPlanAfterBatch(acceptedOverlay.acceptedPlan, progress.completedTaskIds);
        const cursor = buildTaskExecutionCursor(acceptedOverlay.acceptedPlan, recentResourcePackets(result.events));
        const context = buildCurrentTaskContext(acceptedOverlay.acceptedPlan, cursor);
        const savepointId = this.id('accepted-plan-overlay-task-savepoint');
        result = await this.append(input.sessionId, [
          acceptedPlanBatchCheckpointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            progressProposal,
            batchEvents,
            progress,
            this.ts(),
            this.id('accepted-plan-overlay-batch-checkpoint')
          ),
          acceptedPlanTaskSavepointEvent(
            input.sessionId,
            plan.runId,
            acceptedOverlay.acceptedPlan,
            nextAccepted,
            progress,
            batchEvents,
            cursor,
            context,
            this.ts(),
            savepointId
          ),
        ]) ?? result;
        if (!acceptedPlanComplete(nextAccepted)) {
          return this.runUserTurn({
            sessionId: input.sessionId,
            content: implementationPlanExecutionRequest(acceptedOverlay.plan, nextAccepted),
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
            projectMemoryMode: input.projectMemoryMode,
            resumeResourcePackets: true,
            acceptedImplementationPlan: nextAccepted,
            interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          });
        }
        plan = {
          ...plan,
          planId: acceptedOverlay.acceptedPlan.planId,
          implementationPlan: acceptedOverlay.acceptedPlan.rawPlan,
        };
      }
      const staticReviewEvents: AgentEvent[] = [];

      const factsReply = await this.kernel({
        command: {
          kind: 'reviewFactsGet',
          requestId: this.id('review-facts-get'),
          runId: plan.runId,
          sessionId: input.sessionId,
        },
      });
      assertKernelReplyOk(factsReply, 'accepted_plan_review_facts_failed', 'Kernel reviewFactsGet failed');
      result = await this.appendProjectedKernelEvents(input.sessionId, factsReply) ?? result;
      const review = reviewSummaryEvent(
        input.sessionId,
        plan,
        [...batchEvents, ...staticReviewEvents.map((event) => event.payload), ...(factsReply.events ?? [])],
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
          interactionOverlay: plan.interactionOverlay ?? input.interactionOverlay,
          ts: this.ts(),
          id: this.id('session-run-waiting-review'),
        }),
      ]) ?? result;
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : String(error);
      const code = error instanceof SessionDriverLoopError ? error.code : 'accepted_plan_execution_failed';
      return this.append(input.sessionId, planActionBundleExecutionExceptionEvents(
        input.sessionId,
        plan,
        message,
        code,
        this.ts(),
        this.id('accepted-action-plan-execution-failed')
      )) ?? result;
    }
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
      result = await this.tryKernelAudit(
        input.sessionId,
        {
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
        },
        'trace/review_accept_noop',
        'Kernel 未接受 Review 修订决策审计；Session 将继续按用户补充信息发起修订流程。'
      ) ?? result;
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
        projectMemoryMode: input.projectMemoryMode,
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
      projectMemoryMode: input.projectMemoryMode,
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
      capabilityCatalogSummary: capabilityCatalogSummaryForState(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
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
    const assembledContext = assembleContext({
      contextAssemblyId: this.id('context-assembly-guidance-revision'),
      workflowState: 'guidanceRevision',
      allowedProposals: ['answer'],
      capabilityCatalogSummary: capabilityCatalogSummaryForState(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
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
      const messages: LlmChatRequest['messages'] = [
        { role: 'system', content: prompt.stablePrefix },
        { role: 'user', content: prompt.dynamicSuffix },
      ];
      const providerResult = state.acceptedImplementationPlan
        ? await this.callProviderProposalOnly(input, state, prompt, 'accepted_plan_provider_call', messages)
        : await this.callProviderWithNativeTools(input, state, prompt, messages);
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
            allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
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
        allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
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
          allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
        });
      } catch (repairError) {
        throw new SessionDriverLoopError(
          'agent_protocol_repair_failed',
          `模型输出不符合 Agent Protocol v3，repair 后仍无法解析：${normalizeParseError(repairError).message}`
        );
      }
    }
  }

  private async tryCompleteAcceptedPlanReadOnlyResourceTask(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    packet: ResourcePacket,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null> {
    const accepted = state.acceptedImplementationPlan;
    if (!accepted) return null;
    refreshTaskExecutionState(state);
    const completion = acceptedPlanReadOnlyResourceCompletion(
      accepted,
      state.taskExecutionCursor,
      state.currentTaskContext,
      packet
    );
    if (!completion.ok) return null;

    const nextAccepted = acceptedPlanAfterBatch(accepted, completion.completedTaskIds);
    const checkpoint = acceptedPlanResourceValidationCheckpointEvent(
      state.sessionId,
      state.runId,
      accepted,
      packet,
      completion,
      this.ts(),
      this.id('accepted-plan-resource-validation-checkpoint')
    );
    let result = await this.append(state.sessionId, [checkpoint]) ?? fallback;

    if (!acceptedPlanComplete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(
          {
            sessionId: state.sessionId,
            runId: state.runId,
            planId: accepted.planId,
            userPlan: accepted.summary ?? accepted.title ?? 'Accepted implementation plan',
            actionBundle: {
              version: '1',
              id: `${accepted.planId}:read-only-validation`,
              goal: 'Read-only validation evidence satisfied the current accepted task.',
              actions: [],
              validationExpectations: [],
              reviewExpectations: [],
            },
            codeBlocks: [],
            commandBlocks: [],
            expectedValidation: '',
            reviewGuide: '',
            implementationPlan: accepted.rawPlan,
          },
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
        projectMemoryMode: input.projectMemoryMode,
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
    const plan = acceptedPlanReadOnlyReviewContext(state, nextAccepted, packet, completion);
    const resourceFact = {
      kind: 'tool.completed',
      toolName: 'kernel.resourceResolve',
      status: 'ok',
      summary: `Kernel resolved ${packet.items.length} resource item(s) for accepted-plan read-only validation.`,
      output: packet,
    };
    const review = reviewSummaryEvent(
      state.sessionId,
      plan,
      [resourceFact, ...(factsReply.events ?? [])],
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

  private async callAcceptedPlanResourceResume(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    requestProposal: ProposalEnvelope,
    packet: ResourcePacket
  ): Promise<ProposalEnvelope> {
    const messages: LlmChatRequest['messages'] = [
      { role: 'system', content: prompt.stablePrefix },
      {
        role: 'user',
        content: acceptedPlanResourceResumePrompt(state, requestProposal, packet),
      },
    ];
    const providerResult = await this.callProviderProposalOnly(
      input,
      state,
      prompt,
      'accepted_plan_resource_resume',
      messages
    );
    if (typeof providerResult !== 'string') return providerResult;
    try {
      return parseAndValidateProposal({
        raw: providerResult,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
        allowBriefActionBundleUserPlan: true,
      });
    } catch (error) {
      const parseError = normalizeParseError(error);
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          `accepted-plan resource resume 输出需要按 Agent Protocol v3 修复：${parseError.message}`,
          this.ts(),
          this.id('accepted-plan-resource-resume-repair')
        ),
      ]);
      const repairedRaw = await this.llm(
        input.profileId,
        state,
        'accepted_plan_resource_resume_repair',
        repairMessages(prompt, state, providerResult, parseError)
      );
      try {
        return parseAndValidateProposal({
          raw: repairedRaw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
          allowBriefActionBundleUserPlan: true,
        });
      } catch (repairError) {
        throw new SessionDriverLoopError(
          'accepted_plan_resource_resume_repair_failed',
          `accepted-plan resource resume repair 后仍无法解析：${normalizeParseError(repairError).message}`
        );
      }
    }
  }

  private async maybeRunStaticSyntaxReview(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    accepted: AcceptedImplementationPlanContext,
    batch: Record<string, unknown>,
    batchEvents: unknown[]
  ): Promise<AgentEvent[]> {
    const packet = staticSyntaxReviewPacket(state, accepted, batch, batchEvents);
    if (!packet.files.length) return [];
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.static_syntax_review',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: `Session 正在对 ${packet.files.length} 个生成代码文件做 Review 前静态语法/API 审查。`,
      payload: {
        runId: state.runId,
        planId: accepted.planId,
        targetPaths: packet.files.map((file) => file.targetPath),
      },
    });
    let parsed: Record<string, unknown>;
    try {
      const raw = await this.llm(
        input.profileId,
        state,
        'accepted_plan_static_syntax_review',
        staticSyntaxReviewMessages(prompt, state, accepted, packet)
      );
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        this.event(state.sessionId, 'workflow_stage', {
          kind: 'accepted_plan.static_syntax_review',
          stage: 'accepted_plan.static_syntax_review',
          status: 'failed',
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'collapsible',
          runId: state.runId,
          planId: accepted.planId,
          summary: `Review 前静态审查未能解析：${message}`,
          targetPaths: packet.files.map((file) => file.targetPath),
          issues: [{ severity: 'warning', message }],
        }),
      ];
    }
    const issues = normalizeStaticSyntaxIssues(parsed.issues);
    const status = issues.length ? 'blocked' : 'completed';
    const summary = stringValue(parsed.summary)
      ?? (issues.length ? `Review 前静态审查发现 ${issues.length} 个潜在问题。` : 'Review 前静态审查未发现明显语法/API 问题。');
    return [
      this.event(state.sessionId, 'workflow_stage', {
        kind: 'accepted_plan.static_syntax_review',
        stage: 'accepted_plan.static_syntax_review',
        status,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        runId: state.runId,
        planId: accepted.planId,
        summary,
        targetPaths: packet.files.map((file) => file.targetPath),
        issues,
      }),
    ];
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

  private async callProviderProposalOnly(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string | ProposalEnvelope> {
    const turn = await this.llmTurn(input.profileId, state, stage, messages, {
      responseFormat: { type: 'json_object' },
    });
    if (turn.toolCalls.length === 0) return turn.content;

    const firstToolCall = turn.toolCalls[0];
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.provider_tool_violation',
      status: 'failed',
      channel: 'progress',
      source: 'session',
      summary: `Complete-stage provider requested native tool ${firstToolCall.name}; Session is retrying once with proposal-only contract.`,
      activity: conversationActivity({
        activityId: `accepted-plan-provider-tool-violation-${firstToolCall.callId}`,
        kind: 'diagnostic',
        status: 'failed',
        title: 'Complete-stage native tool blocked',
        summary: `Provider requested ${firstToolCall.name} during proposal-only accepted-plan execution.`,
        source: 'session',
        runId: state.runId,
        toolName: firstToolCall.name,
      }),
      payload: {
        visibility: 'task',
        callId: firstToolCall.callId,
        name: firstToolCall.name,
        arguments: firstToolCall.arguments,
        stage,
        acceptedPlanId: state.acceptedImplementationPlan?.planId,
      },
    });
    const repairedRaw = await this.llm(
      input.profileId,
      state,
      `${stage}_tool_violation_repair`,
      completeStageToolViolationRepairMessages(prompt, state, firstToolCall, turn)
    );
    try {
      return parseAndValidateProposal({
        raw: repairedRaw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'accepted_plan_provider_tool_violation',
        `Complete-stage provider requested native tool ${firstToolCall.name}; proposal-only repair failed: ${normalizeParseError(error).message}`
      );
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
        activity: conversationActivity({
          activityId: `native-tool-round-${round + 1}`,
          kind: 'toolExecution',
          status: 'running',
          title: 'Native tool checkpoint',
          summary: 'Provider requested read-only native tools. Session is routing them through Kernel resource boundaries.',
          source: 'session',
          runId: state.runId,
          itemCount: turn.toolCalls.length,
        }),
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

    const repeatedReadCalls = turn.toolCalls
      .map((toolCall) => {
        const signature = nativeToolReadSignature(toolCall);
        return { toolCall, signature, entry: state.nativeToolReadLedger.get(signature.key) };
      })
      .filter((item): item is { toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry } => Boolean(item.entry));
    if (repeatedReadCalls.length > 0) {
      const proposal = this.tryParseNativeToolTurnProposal(state, turn);
      if (proposal) {
        return { kind: 'proposal', proposal };
      }
    }
    if (repeatedReadCalls.some((item) => item.entry.repeatCount > 0)) {
      const repaired = await this.repairDuplicateNativeReadTool(input, state, prompt, turn, repeatedReadCalls);
      return {
        kind: 'proposal',
        proposal: repaired,
      };
    }

    const toolMessages: LlmChatRequest['messages'] = [];
    for (const toolCall of turn.toolCalls) {
      const signature = nativeToolReadSignature(toolCall);
      const existing = state.nativeToolReadLedger.get(signature.key);
      if (existing) {
        existing.repeatCount += 1;
        await this.emitProjectionDelta(state, {
          type: 'stage_delta',
          stage: 'native_tool_duplicate_read',
          status: 'completed',
          channel: 'tool',
          source: 'session',
          itemId: toolCall.callId,
          summary: `Provider repeated ${toolCall.name} for an already resolved target; Session is reusing the existing ResourcePacket without another Kernel read.`,
          activity: conversationActivity({
            activityId: `native-tool-duplicate-${toolCall.callId}`,
            kind: 'resourceRead',
            status: 'completed',
            title: 'Duplicate native read reused',
            summary: `Session reused ${existing.packet.id} for a repeated ${toolCall.name} request.`,
            source: 'session',
            runId: state.runId,
            toolName: toolCall.name,
            targets: [existing.signature.path],
          }),
          payload: {
            callId: toolCall.callId,
            name: toolCall.name,
            duplicateOfPacketId: existing.packet.id,
            duplicateCount: existing.repeatCount,
            signature: existing.signature,
            contentHash: existing.contentHash,
          },
        });
        toolMessages.push({
          role: 'tool',
          toolCallId: toolCall.callId,
          content: clipJson(nativeToolDuplicateResult(toolCall, existing), NATIVE_TOOL_RESULT_MAX_CHARS),
        });
        continue;
      }
      await this.emitProjectionDelta(state, {
        type: 'tool_call_delta',
        stage: 'native_tool_call',
        status: 'running',
        channel: 'tool',
        source: 'session',
        itemId: toolCall.callId,
        summary: nativeToolResolveRunningSummary(toolCall.name, language),
        activity: conversationActivity({
          activityId: `native-tool-${toolCall.callId}`,
          kind: 'toolExecution',
          status: 'running',
          title: 'Resolving native read tool',
          summary: nativeToolResolveRunningSummary(toolCall.name, language),
          source: 'session',
          runId: state.runId,
          toolName: toolCall.name,
        }),
        payload: {
          callId: toolCall.callId,
          name: toolCall.name,
          arguments: toolCall.arguments,
          nativeToolRound: round,
        },
      });
      const packet = await this.resolveNativeReadToolCall(state, toolCall);
      state.nativeToolReadLedger.set(signature.key, {
        signature,
        packet,
        contentHash: nativeToolPacketContentHash(packet),
        repeatCount: 0,
      });
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
        activity: resourcePacketActivity(packet, `native-tool-resource-${toolCall.callId}`, state.runId),
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
      activity: conversationActivity({
        activityId: `native-tool-side-effect-${toolCall.callId}`,
        kind: 'diagnostic',
        status: 'failed',
        title: 'Native tool blocked',
        summary: 'Provider requested a side-effect tool. Session is converting it back through the plan/permission path.',
        source: 'session',
        runId: state.runId,
        toolName: toolCall.name,
      }),
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

  private tryParseNativeToolTurnProposal(
    state: SessionDriverLoopRunState,
    turn: LlmTurnResult
  ): ProposalEnvelope | null {
    if (!turn.content.trim().startsWith('{')) return null;
    try {
      return parseAndValidateProposal({
        raw: turn.content,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch {
      return null;
    }
  }

  private async repairDuplicateNativeReadTool(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    turn: LlmTurnResult,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
  ): Promise<ProposalEnvelope> {
    if (state.nativeToolDuplicateRepairAttempted) {
      const duplicateSummary = duplicates
        .map((item) => `${item.toolCall.name}:${item.signature.path}`)
        .join(', ');
      throw new SessionDriverLoopError(
        'native_tool_duplicate_loop',
        `Provider repeated already-resolved read-only native tool calls after repair: ${duplicateSummary}. Session stopped the run to avoid an infinite ResourceResolve loop.`
      );
    }
    state.nativeToolDuplicateRepairAttempted = true;
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'native_tool_duplicate_repair',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: 'Provider repeated already resolved read-only native tool targets; Session is requesting a no-tool proposal.',
      activity: conversationActivity({
        activityId: `native-tool-duplicate-repair-${state.runId}`,
        kind: 'diagnostic',
        status: 'running',
        title: 'Duplicate native read repair',
        summary: 'Session detected repeated read-only native tool calls with no new evidence.',
        source: 'session',
        runId: state.runId,
        targets: duplicates.map((item) => item.signature.path),
      }),
      payload: {
        visibility: 'task',
        duplicateTargets: duplicates.map((item) => ({
          callId: item.toolCall.callId,
          toolName: item.toolCall.name,
          signature: item.signature,
          packetId: item.entry.packet.id,
          contentHash: item.entry.contentHash,
          repeatCount: item.entry.repeatCount,
        })),
      },
    });
    const raw = await this.llm(
      input.profileId,
      state,
      'native_tool_duplicate_repair',
      nativeToolDuplicateRepairMessages(prompt, state, turn, duplicates)
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
        'native_tool_duplicate_repair_failed',
        `Provider repeated read-only native tools and duplicate-loop repair did not return a valid Agent Protocol v3 proposal: ${normalizeParseError(error).message}`
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

  private async repairActionBundleAdmission(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    reasons: string[],
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    if (state.actionBundleAdmissionRepairAttempted) {
      return this.append(state.sessionId, actionBundleAdmissionFailureEvents(
        state.sessionId,
        state.runId,
        proposal,
        reasons,
        this.ts(),
        this.id('action-bundle-admission-failed')
      )) ?? fallback;
    }
    state.actionBundleAdmissionRepairAttempted = true;
    let result = await this.append(state.sessionId, [
      actionBundleAdmissionRepairingEvent(
        state.sessionId,
        state.runId,
        proposal,
        reasons,
        this.ts(),
        this.id('action-bundle-admission-repairing')
      ),
    ]) ?? fallback;

    let repaired: ProposalEnvelope;
    try {
      const raw = await this.llm(input.profileId, state, 'action_bundle_admission_repair', actionBundleAdmissionRepairMessages(prompt, state, proposal, reasons));
      repaired = parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      const message = error instanceof SessionDriverLoopError ? error.message : normalizeParseError(error).message;
      return this.append(state.sessionId, actionBundleAdmissionFailureEvents(
        state.sessionId,
        state.runId,
        proposal,
        [`actionBundle admission repair failed: ${message}`],
        this.ts(),
        this.id('action-bundle-admission-repair-failed')
      )) ?? result;
    }

    if (repaired.kind === 'actionBundle') {
      return this.submitActionProposal(input, state, prompt, repaired, result);
    }
    if (repaired.kind === 'resourceRequest') {
      const generated = generatedArtifactResourcePacketForRequest(
        state,
        repaired.payload as ResourceRequestDraft,
        this.id('action-bundle-admission-generated-resource')
      );
      if (generated.packet) {
        state.resourcePackets.push(generated.packet);
        result = await this.append(state.sessionId, [
          resourcePacketEvent(state.sessionId, generated.packet, this.ts(), this.id('action-bundle-admission-generated-resource-context')),
        ]) ?? result;
      }
      const subset = manifestForResourceRequest(state.manifest, generated.remaining, state.conversationRoots);
      if (!subset.manifest.entries.length) {
        if (!generated.packet) {
          return this.append(state.sessionId, actionBundleAdmissionFailureEvents(
            state.sessionId,
            state.runId,
            proposal,
            [`actionBundle admission repair returned resourceRequest that cannot be resolved: ${resourceResolutionDiagnostic(subset).fallback}`],
            this.ts(),
            this.id('action-bundle-admission-resource-invalid')
          )) ?? result;
        }
      } else {
        const packet = await this.resolveResources(state, subset.manifest);
        state.resourcePackets.push(packet);
        addDiscoveredManifestEntries(state.manifest, packet);
        result = await this.append(state.sessionId, [
          resourcePacketEvent(state.sessionId, packet, this.ts(), this.id('action-bundle-admission-resource-context')),
        ]) ?? result;
      }
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: actionBundleAdmissionResourceFollowupRequest(state, reasons),
        attachments: input.attachments ?? [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
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
        id: this.id('action-bundle-admission-decision'),
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
          id: this.id('session-run-waiting-action-bundle-admission-decision'),
        }),
      ]) ?? result;
    }
    if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          diag(
            'actionBundleAdmissionRepairReturnedPlan',
            'Action-bundle admission repair returned a plan proposal during execution. Session will not switch execution repair back into plan review; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
            { returnedKind: repaired.kind, proposalId: repaired.proposalId }
          ),
          this.ts(),
          this.id('action-bundle-admission-repair-plan-forbidden')
        ),
      ]) ?? result;
    }
    if (repaired.kind === 'answer') {
      return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]) ?? result;
    }
    if (repaired.kind === 'diagnostic') {
      const diagnostic = objectRecord(repaired.payload) ?? {};
      const summary = stringValue(diagnostic.summary)
        ?? stringValue(diagnostic.details)
        ?? 'actionBundle admission repair returned a diagnostic instead of a file-level plan.';
      return this.append(state.sessionId, [
        finalDiagnosticEvent(state.sessionId, summary, this.ts(), this.id('action-bundle-admission-diagnostic')),
      ]) ?? result;
    }
    return this.submitNonExecutableProposal(state, repaired, result);
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
    if (actionBundle) {
      const admissionBatch = proposalActionBundleAdmissionBatch(proposal);
      const admissionReasons = acceptedPlanDeletePreflightReasons(admissionBatch, state.resourcePackets);
      if (admissionReasons.length) {
        return this.repairActionBundleAdmission(input, state, prompt, proposal, admissionReasons, fallback);
      }
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
          diag('planProposalReviewedMissing', 'Kernel did not return a proposal.reviewed event for the actionBundle; Session will not display a confirmable plan.'),
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
            diag('planRevisionRepairFailed', `The plan needs revision, but model repair failed: ${message}`, { message }),
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
          diag('planRejected', `Kernel rejected the plan: ${planReviewDiagnosticSummary(reviewReport)}`, { reasons: planReviewDiagnosticSummary(reviewReport) }),
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
            'The current execution batch is outside the confirmed current-task scope; Session is asking the model to continue the current task or request additional authorization.',
            this.ts(),
            this.id('accepted-plan-scope-repair'),
            {
              messageKey: 'session.driver.acceptedPlanScopeRepair',
              messageArgs: {},
            }
          ),
        ]);
        try {
          const repaired = await this.repairAcceptedPlanScope(input, state, prompt, proposal, validation);
          if (repaired.kind === 'actionBundle') {
            return this.submitAcceptedPlanActionProposal(input, state, prompt, repaired, fallback);
          }
          if (repaired.kind === 'resourceRequest') {
            let result = fallback;
            const generated = generatedArtifactResourcePacketForRequest(
              state,
              repaired.payload as ResourceRequestDraft,
              this.id('accepted-plan-repair-generated-resource')
            );
            if (generated.packet) {
              state.resourcePackets.push(generated.packet);
              result = await this.append(state.sessionId, [
                resourcePacketEvent(state.sessionId, generated.packet, this.ts(), this.id('accepted-plan-repair-generated-resource-context')),
              ]) ?? result;
            }
            const subset = manifestForResourceRequest(state.manifest, generated.remaining, state.conversationRoots);
            if (!subset.manifest.entries.length) {
              if (!generated.packet) {
                return this.append(state.sessionId, [
                  finalDiagnosticEvent(
                    state.sessionId,
                    diag(
              'autoBatchResourceResolveFailed',
              `Automatic execution batch requires additional resource evidence, but the repaired resourceRequest could not be located: ${resourceResolutionDiagnostic(subset).fallback}`,
              { detail: resourceResolutionDiagnostic(subset).fallback }
            ),
                    this.ts(),
                    this.id('accepted-plan-scope-repair-resource-invalid')
                  ),
                ]);
              }
            } else {
              const packet = await this.resolveResources(state, subset.manifest);
              state.resourcePackets.push(packet);
              addDiscoveredManifestEntries(state.manifest, packet);
              result = await this.append(state.sessionId, [
                resourcePacketEvent(state.sessionId, packet, this.ts(), this.id('accepted-plan-repair-resource-context')),
              ]) ?? result;
            }
            return this.runUserTurn({
              sessionId: input.sessionId,
              content: implementationPlanExecutionRequest(
                acceptedPlanExecutionContext(state, proposal, {}),
                accepted,
                'Session 已补充当前修改所需的只读 search/read 证据；请基于 ResourcePacket 输出同一 accepted taskPlan 范围内的下一批 actionBundle。'
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
              projectMemoryMode: input.projectMemoryMode,
              resumeResourcePackets: true,
              acceptedImplementationPlan: accepted,
            });
          }
          if (repaired.kind === 'decisionRequest') {
            const requirement = requirementRecordFromProposal(repaired, input, state, this.ts());
            const interactionOverlay: InteractionOverlayContext = {
              parentRunId: state.runId,
              parentPhase: 'executing_accepted_plan',
              interactionRunId: state.runId,
              interactionId: requirement.requirementId,
              sourceInteractionId: repaired.proposalId,
            };
            const confirmation = requirementConfirmationEvent({
              sessionId: state.sessionId,
              runId: state.runId,
              requirement,
              proposal: repaired,
              originalUserRequest: input.content,
              attachments: input.attachments ?? [],
              interactionOverlay,
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
                interactionOverlay,
                ts: this.ts(),
                id: this.id('session-run-waiting-accepted-plan-repair-decision'),
              }),
            ]);
          }
          if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
            return this.append(state.sessionId, [
              finalDiagnosticEvent(
                state.sessionId,
                diag(
                  'acceptedPlanScopeRepairReturnedPlan',
                  'Accepted-plan execution repair returned a plan proposal. Session will not re-enter plan review from an accepted task; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
                  { returnedKind: repaired.kind, proposalId: repaired.proposalId }
                ),
                this.ts(),
                this.id('accepted-plan-scope-repair-plan-forbidden')
              ),
            ]);
          }
          return this.submitNonExecutableProposal(state, repaired, fallback);
        } catch (error) {
          const message = error instanceof SessionDriverLoopError ? error.message : String(error);
          return this.append(state.sessionId, [
            finalDiagnosticEvent(
              state.sessionId,
              diag('autoBatchScopeRepairFailed', `Automatic execution batch went out of scope and model repair failed: ${message}`, { message }),
              this.ts(),
              this.id('accepted-plan-scope-repair-failed')
            ),
          ]);
        }
      }
      return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, validation);
    }

    const scopeCanonicalization = canonicalizeAcceptedPlanExecutionAccessScopes(accepted, proposal);
    const executionProposal = scopeCanonicalization.proposal;
    state.phase = 'executing_accepted_plan';
    let result = fallback;
    if (scopeCanonicalization.changed) {
      result = await this.append(state.sessionId, [
        acceptedPlanAccessScopesCanonicalizedEvent(
          state.sessionId,
          state.runId,
          accepted,
          scopeCanonicalization,
          this.ts(),
          this.id('accepted-plan-access-scopes-canonicalized')
        ),
      ]) ?? result;
    }
    result = await this.append(state.sessionId, [
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
    ]) ?? result;

    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit-accepted-plan'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal: executionProposal,
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
          diag('autoPlanProposalReviewedMissing', 'Kernel did not return a proposal.reviewed event for the accepted-plan actionBundle; Session will not auto-execute this batch.'),
          this.ts(),
          this.id('accepted-plan-review-missing')
        ),
      ]);
    }
    if (reviewReport && acceptedPlanReviewNeedsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'Kernel PlanReview 要求修订当前自动执行批次，Session 正在进行一次受控 repair。',
          this.ts(),
          this.id('accepted-plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, executionProposal, reviewReport);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(state.sessionId, [
          finalDiagnosticEvent(
            state.sessionId,
            diag('autoBatchRevisionRepairFailed', `The automatic execution batch needs revision, but model repair failed: ${message}`, { message }),
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
          diag('autoBatchRejected', `Kernel rejected the automatic execution batch: ${planReviewDiagnosticSummary(reviewReport)}`, { reasons: planReviewDiagnosticSummary(reviewReport) }),
          this.ts(),
          this.id('accepted-plan-review-denied')
        ),
      ]);
    }
    if (reviewReport.status === 'needsRevision') {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, executionProposal, {
        ok: false,
        reasons: [`Kernel PlanReview 要求修订当前批次：${planReviewDiagnosticSummary(reviewReport)}`],
      });
    }

    const autoGrantBlockers = nonAcceptedPlanPermissionGaps(reviewReport, accepted);
    if (autoGrantBlockers.length) {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, executionProposal, {
        ok: false,
        reasons: autoGrantBlockers.map((capability) => `当前批次需要额外权限 ${capability}，不属于 accepted taskPlan 自动执行范围。`),
      });
    }

    const plan = acceptedPlanExecutionContext(state, executionProposal, reviewReport);
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

    const normalizedBatch = normalizeAcceptedPlanKernelBatch(accepted.planId, plan, accepted);
    if (!normalizedBatch.ok) {
      return this.append(state.sessionId, acceptedPlanNormalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        normalizedBatch.reasons,
        this.ts(),
        this.id('accepted-plan-batch-normalization-failed')
      )) ?? result;
    }
    const batch = normalizedBatch.batch;
    const deletePreflightReasons = acceptedPlanDeletePreflightReasons(batch, state.resourcePackets);
    if (deletePreflightReasons.length) {
      return this.append(state.sessionId, acceptedPlanNormalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        deletePreflightReasons,
        this.ts(),
        this.id('accepted-plan-delete-preflight-failed')
      )) ?? result;
    }
    await this.appendProviderTrace(state, 'accepted_plan.action_batch_preflight', {
      planId: accepted.planId,
      batchIndex: accepted.batchIndex,
      audit: acceptedPlanBatchPreflightAudit(batch),
    });

    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.action_batch_submit',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: acceptedPlanBatchActivitySummary(batch),
      activity: acceptedPlanBatchActivity(accepted, batch, 'running'),
      payload: {
        visibility: 'task',
        planId: accepted.planId,
        batchIndex: accepted.batchIndex,
        actionCount: Array.isArray((batch as Record<string, unknown>).actions)
          ? ((batch as Record<string, unknown>).actions as unknown[]).length
          : undefined,
      },
    });

    const batchReply = await this.kernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: this.id('accepted-plan-action-batch-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        batch,
      },
    });
    await this.emitKernelActivityDeltas(state, batchReply.events ?? [], 'accepted_plan.action_batch_submit');
    result = await this.appendProjectedKernelEvents(state.sessionId, batchReply) ?? result;
    const batchEvents = batchReply.events ?? [];
    if (actionBatchHasFailureOrBlocker(batchEvents)) {
      return this.append(state.sessionId, acceptedPlanExecutionFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        batchEvents,
        batch,
        this.ts(),
        this.id('accepted-plan-batch-failed')
      )) ?? result;
    }
    const generatedPacket = generatedArtifactResourcePacketFromSuccessfulBatch(
      state,
      batch,
      batchEvents,
      this.id('generated-artifact-evidence')
    );
    if (generatedPacket) {
      indexGeneratedArtifactEvidence(state, generatedPacket);
      state.resourcePackets.push(generatedPacket);
      result = await this.append(state.sessionId, [
        resourcePacketEvent(state.sessionId, generatedPacket, this.ts(), this.id('accepted-plan-generated-artifact-evidence')),
      ]) ?? result;
    }
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
    const batchProgress = acceptedPlanBatchProgress(accepted, executionProposal, batchReply.events ?? []);
    const nextAccepted = acceptedPlanAfterBatch(accepted, batchProgress.completedTaskIds);
    refreshTaskExecutionState(state);
    const savepointId = this.id('accepted-plan-task-savepoint');
    result = await this.append(state.sessionId, [
      acceptedPlanBatchCheckpointEvent(
        state.sessionId,
        state.runId,
        accepted,
        executionProposal,
        batchReply.events ?? [],
        batchProgress,
        this.ts(),
        this.id('accepted-plan-batch-checkpoint')
      ),
      acceptedPlanTaskSavepointEvent(
        state.sessionId,
        state.runId,
        accepted,
        nextAccepted,
        batchProgress,
        batchReply.events ?? [],
        state.taskExecutionCursor,
        state.currentTaskContext,
        this.ts(),
        savepointId
      ),
    ]) ?? result;
    if (state.taskExecutionCursor) state.taskExecutionCursor.lastSavepointId = savepointId;

    if (!actionBatchHasFailureOrBlocker(batchReply.events ?? []) && !acceptedPlanComplete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(
          { ...acceptedPlanExecutionContext(state, executionProposal, reviewReport), implementationPlan: accepted.rawPlan },
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
        projectMemoryMode: input.projectMemoryMode,
        resumeResourcePackets: true,
        acceptedImplementationPlan: nextAccepted,
      });
    }

    const staticReviewEvents = await this.maybeRunStaticSyntaxReview(
      input,
      state,
      prompt,
      accepted,
      batch,
      batchEvents
    );
    if (staticReviewEvents.length) {
      result = await this.append(state.sessionId, staticReviewEvents) ?? result;
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
      [...(batchReply.events ?? []), ...staticReviewEvents.map((event) => event.payload), ...(factsReply.events ?? [])],
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
    const interactionOverlay: InteractionOverlayContext = {
      parentRunId: state.runId,
      parentPhase: 'executing_accepted_plan',
      interactionRunId: state.runId,
      interactionId: requirement.requirementId,
      sourceInteractionId: proposal.proposalId,
    };
    const confirmation = requirementConfirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal: decisionProposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      interactionOverlay,
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
        interactionOverlay,
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
        allowBriefActionBundleUserPlan: true,
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
    await this.appendProviderTrace(state, `${stage}.request`, {
      profileId,
      messages: ensureJsonObjectModeMessages(messages, options.responseFormat),
      cachePlan: state.cachePlan,
      contextAssembly: state.contextAssembly,
      responseFormat: options.responseFormat,
      responseFormatAudit: jsonObjectResponseFormatAudit(messages, options.responseFormat),
    });
    await this.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: this.ports.llmChatStream ? 'streaming' : 'running',
      channel: 'progress',
      source: 'session',
      summary: providerStageSummary(stage, 'request', visibleLanguageForRequest(state.userRequest)),
      activity: providerActivity(state, stage, 'running'),
    });
    const request: LlmChatRequest = {
      profileId,
      messages: ensureJsonObjectModeMessages(messages, options.responseFormat),
      responseFormat: options.responseFormat,
      tools: options.tools,
      stream: Boolean(this.ports.llmChatStream),
      providerOptions: {
        deepcode: {
          cachePlan: state.cachePlan,
        },
      },
    };
    const toolCallBuffer = new ProviderToolCallBuffer();
    const reasoningBuffer: ProviderReasoningDeltaBuffer = {
      pending: '',
      lastFlushAt: Date.now(),
      itemId: undefined,
    };
    const result = this.ports.llmChatStream
      ? await this.ports.llmChatStream(request, async (event) => {
        await this.handleLlmStreamEvent(state, stage, event, toolCallBuffer, reasoningBuffer);
      })
      : await this.ports.llmChat(request);
    await this.flushProviderReasoningBuffer(state, stage, reasoningBuffer);
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
    }
    await this.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: 'completed',
      channel: 'progress',
      source: 'provider',
      summary: providerStageSummary(stage, 'response', visibleLanguageForRequest(state.userRequest)),
      activity: providerActivity(state, stage, 'completed'),
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
    toolCallBuffer: ProviderToolCallBuffer,
    reasoningBuffer: ProviderReasoningDeltaBuffer
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
      } else if (providerStageEmitsJsonProgress(stage)) {
        await this.emitProviderJsonStreamProgress(state, stage, chunk.content);
      }
      return;
    }
    if (event.type === 'provider_reasoning_delta' && chunk?.content) {
      await this.bufferProviderReasoningDelta(state, stage, reasoningBuffer, chunk);
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
        activity: conversationActivity({
          activityId: `provider-tool-${chunk.callId ?? chunk.index ?? 0}`,
          kind: 'toolExecution',
          status: 'running',
          title: 'Provider tool call',
          summary: chunk.toolCallDelta?.name
            ? providerToolCallPreparingSummary(chunk.toolCallDelta.name, language)
            : providerToolCallStreamingSummary(language),
          source: 'provider',
          runId: state.runId,
          toolName: chunk.toolCallDelta?.name,
        }),
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
        activity: conversationActivity({
          activityId: `provider-${stage}-stream-error`,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Provider stream error',
          summary: event.error ?? chunk?.error ?? 'Provider stream error.',
          source: 'provider',
          runId: state.runId,
        }),
        payload: event.rawProvider ?? chunk?.rawProvider,
      });
    }
  }

  private async bufferProviderReasoningDelta(
    state: SessionDriverLoopRunState,
    stage: string,
    buffer: ProviderReasoningDeltaBuffer,
    chunk: LlmChatResult['chunks'][number]
  ): Promise<void> {
    if (typeof chunk.content !== 'string' || chunk.content.length === 0) return;
    buffer.pending += chunk.content;
    buffer.itemId = chunk.callId ?? buffer.itemId;
    const now = Date.now();
    if (
      buffer.pending.length < PROVIDER_REASONING_FLUSH_CHARS &&
      now - buffer.lastFlushAt < PROVIDER_REASONING_FLUSH_MS
    ) {
      return;
    }
    await this.flushProviderReasoningBuffer(state, stage, buffer);
  }

  private async flushProviderReasoningBuffer(
    state: SessionDriverLoopRunState,
    stage: string,
    buffer: ProviderReasoningDeltaBuffer
  ): Promise<void> {
    if (!buffer.pending) return;
    const delta = buffer.pending;
    buffer.pending = '';
    buffer.lastFlushAt = Date.now();
    await this.emitProjectionDelta(state, {
      type: 'reasoning_delta',
      stage,
      status: 'streaming',
      channel: 'reasoning',
      source: 'provider',
      itemId: buffer.itemId,
      delta,
      activity: providerActivity(state, stage, 'running'),
      payload: {
        presentation: 'reasoningTrace',
        streamMode: 'markdownBlocks',
        buffered: true,
      },
    });
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
    const activity = delta.activity ?? projectionDeltaActivity(state, delta);
    await this.ports.onProjectionDelta({
      ...delta,
      activity,
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: activeTurn.turnId,
      seq: activeTurn.seq,
    });
  }

  private async emitProviderJsonStreamProgress(
    state: SessionDriverLoopRunState,
    stage: string,
    content: string
  ): Promise<void> {
    const activeTurn = state.activeTurn ?? {
      turnId: this.id('active-turn'),
      seq: 0,
      stage,
    };
    activeTurn.providerJsonStreamProgress ??= {};
    const progress = activeTurn.providerJsonStreamProgress[stage] ?? {
      receivedChars: 0,
      lastEmittedChars: 0,
    };
    progress.receivedChars += content.length;
    activeTurn.providerJsonStreamProgress[stage] = progress;
    state.activeTurn = activeTurn;

    const shouldEmit = progress.lastEmittedChars === 0 ||
      progress.receivedChars - progress.lastEmittedChars >= 1_500;
    if (!shouldEmit) return;
    progress.lastEmittedChars = progress.receivedChars;
    const language = visibleLanguageForRequest(state.userRequest);
    const summary = providerJsonStreamProgressSummary(language, progress.receivedChars);
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage,
      status: 'streaming',
      channel: 'progress',
      source: 'session',
      itemId: `${stage}-provider-json-progress`,
      summary,
      activity: providerActivity(state, stage, 'running'),
      payload: {
        stage,
        receivedChars: progress.receivedChars,
        rawJsonHidden: true,
        reason: 'proposal_json_stream_hidden_from_assistant',
      },
    });
  }

  private async emitKernelActivityDeltas(
    state: SessionDriverLoopRunState,
    kernelEvents: unknown[],
    stage: string
  ): Promise<void> {
    const workUnitFacts = indexKernelWorkUnitFacts(kernelEvents);
    for (let index = 0; index < kernelEvents.length; index += 1) {
      const record = objectRecord(kernelEvents[index]);
      if (!record) continue;
      const enriched = enrichKernelWorkUnitRecord(record, workUnitFacts);
      const activity = kernelEventActivity(enriched, `kernel-activity-${index}`, state.runId);
      if (!activity) continue;
      await this.emitProjectionDelta(state, {
        type: kernelActivityDeltaType(enriched),
        stage,
        status: projectionStatusForActivity(activity),
        channel: kernelActivityChannel(activity),
        source: 'kernel',
        itemId: activity.workUnitIds?.[0] ?? activity.actionIds?.[0] ?? activity.toolName ?? activity.activityId,
        targetPath: activity.targets?.[0],
        summary: activity.summary,
        activity,
        payload: {
          kernelEvent: enriched,
          activity,
        },
      });
    }
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
    const enrichedFrame = {
      ...frame,
      draftId: frame.draftId,
      targetPath: frame.targetPath,
    };
    await this.emitProjectionDelta(state, {
      type: 'part_delta',
      stage,
      status: 'streaming',
      channel: enrichedFrame.partKind === 'thinkingDelta' ? 'reasoning' : 'draft',
      source: 'session',
      itemId: enrichedFrame.frameId ?? enrichedFrame.draftId,
      draftId: enrichedFrame.draftId,
      targetPath: enrichedFrame.targetPath,
      delta: enrichedFrame.chunk,
      summary: enrichedFrame.summary ?? `Provider stream part: ${enrichedFrame.partKind}`,
      payload: enrichedFrame,
    });

    const reply = await this.ports.kernelCommand({
      requestId: this.id('draft-ledger-submit'),
      command: {
        kind: 'draftLedgerSubmit',
        requestId: this.id('draft-ledger'),
        runId: state.runId,
        sessionId: state.sessionId,
        frame: {
          ...enrichedFrame,
          runId: enrichedFrame.runId ?? state.runId,
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
        itemId: enrichedFrame.frameId ?? enrichedFrame.draftId,
        draftId: enrichedFrame.draftId,
        targetPath: enrichedFrame.targetPath,
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
        itemId: stringValue(record?.draftId) ?? enrichedFrame.draftId,
        draftId: stringValue(record?.draftId) ?? enrichedFrame.draftId,
        targetPath: enrichedFrame.targetPath,
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

  private async tryKernelAudit(
    sessionId: string,
    request: KernelCommandEnvelope,
    traceKind: AgentEvent['kind'],
    summary: string
  ): Promise<AgentSessionResult> {
    try {
      const reply = await this.ports.kernelCommand(request);
      if (reply.ok) {
        return this.appendProjectedKernelEvents(sessionId, reply);
      }
      return this.append(sessionId, [
        traceEvent(sessionId, traceKind, summary, this.ts(), this.id('kernel-audit-noop'), {
          errorCode: reply.error?.code ?? 'kernel_audit_failed',
          errorMessage: reply.error?.message ?? 'Kernel audit command failed.',
        }),
      ]);
    } catch (error) {
      return this.append(sessionId, [
        traceEvent(sessionId, traceKind, summary, this.ts(), this.id('kernel-audit-noop'), {
          errorCode: error instanceof SessionDriverLoopError ? error.code : 'kernel_audit_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      ]);
    }
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
    const workUnitFacts = indexKernelWorkUnitFacts(reply.events ?? []);
    const events = (reply.events ?? []).map((event) => {
      const record = objectRecord(event);
      const projected = record ? enrichKernelWorkUnitRecord(record, workUnitFacts) : event;
      return projectKernelEvent(sessionId, projected, this.ts(), this.id('kernel'));
    });
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

const JSON_OBJECT_MODE_INSTRUCTION =
  'Return exactly one valid JSON object. Do not return markdown, prose outside JSON, or multiple JSON objects.';

function ensureJsonObjectModeMessages(
  messages: LlmChatRequest['messages'],
  responseFormat: unknown
): LlmChatRequest['messages'] {
  if (!isJsonObjectResponseFormat(responseFormat) || messagesContainJsonInstruction(messages)) {
    return messages;
  }
  return [
    { role: 'system', content: JSON_OBJECT_MODE_INSTRUCTION },
    ...messages,
  ];
}

function jsonObjectResponseFormatAudit(
  messages: LlmChatRequest['messages'],
  responseFormat: unknown
): Record<string, unknown> | undefined {
  if (!isJsonObjectResponseFormat(responseFormat)) return undefined;
  const jsonInstructionPresent = messagesContainJsonInstruction(messages);
  return {
    mode: 'json_object',
    jsonInstructionPresent,
    injectedJsonInstruction: !jsonInstructionPresent,
  };
}

function isJsonObjectResponseFormat(responseFormat: unknown): boolean {
  return objectRecord(responseFormat)?.type === 'json_object';
}

function messagesContainJsonInstruction(messages: LlmChatRequest['messages']): boolean {
  return messages.some((message) => typeof message.content === 'string' && /\bjson\b/i.test(message.content));
}

function assertKernelReplyOk(reply: KernelReply, code: string, fallback: string): void {
  if (reply.ok) return;
  if ((reply.events ?? []).length > 0) return;
  throw new SessionDriverLoopError(code, kernelReplyErrorMessage(reply, fallback));
}

function kernelReplyErrorMessage(reply: KernelReply, fallback: string): string {
  const message = reply.error?.message?.trim();
  const code = reply.error?.code?.trim();
  if (message && code) return `${code}: ${message}`;
  return message || code || fallback;
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

function toolCatalogSnapshotForState(state: SessionDriverLoopRunState): KernelToolCatalogSnapshot | undefined {
  return state.stateContract?.toolCatalogSnapshot ?? state.driverRequest?.stateContract?.toolCatalogSnapshot;
}

function capabilityCatalogSummaryForState(state: SessionDriverLoopRunState): string {
  const snapshot = toolCatalogSnapshotForState(state);
  if (snapshot?.tools?.length) {
    const lines = snapshot.tools
      .slice()
      .sort((left, right) => left.toolId.localeCompare(right.toolId))
      .map((tool) => {
        const kind = tool.operationKind ? ` kind=${tool.operationKind}` : '';
        return `- ${tool.toolId}: capability=${tool.capability}${kind} risk=${tool.risk} permission=${tool.permissionMode} pathScope=${tool.pathScopePolicy}`;
      });
    return [
      `KernelToolCatalog ${snapshot.catalogVersion} hash=${snapshot.catalogHash}`,
      ...lines,
      'Use Kernel capabilities in actionBundle. Executor tool names are runtime facts, not permission grants.',
    ].join('\n');
  }
  const capabilities = state.stateContract?.capabilityProjection ?? state.driverRequest?.stateContract?.capabilityProjection ?? [];
  return capabilities.join('\n');
}

function providerToolDefinitionFromCatalogTool(
  tool: KernelToolCatalogTool,
  snapshot: KernelToolCatalogSnapshot
): ToolDefinition {
  return {
    name: tool.toolId,
    description: `Kernel tool ${tool.toolId} (${tool.capability}).`,
    inputSchema: tool.providerSchema,
    riskLevel: tool.risk === 'critical' ? 'critical' : tool.risk === 'high' ? 'high' : tool.risk === 'medium' ? 'medium' : 'low',
    needsApproval: tool.permissionMode !== 'allow',
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
    capability: tool.capability,
    family: tool.family,
    operationKind: tool.operationKind,
    permissionMode: tool.permissionMode,
    pathScopePolicy: tool.pathScopePolicy,
    executionMode: tool.executionMode,
    readOnly: tool.readOnly,
    catalogVersion: snapshot.catalogVersion,
    catalogHash: snapshot.catalogHash,
  };
}

function catalogProviderToolsForState(state: SessionDriverLoopRunState, names: Set<string>): ToolDefinition[] {
  const snapshot = toolCatalogSnapshotForState(state);
  if (!snapshot?.tools?.length) {
    return listDefaultAgentTools('askBeforeWrite').filter((tool) => names.has(tool.name));
  }
  return snapshot.tools
    .filter((tool) => names.has(tool.toolId))
    .filter((tool) => tool.executionMode === 'execute')
    .map((tool) => providerToolDefinitionFromCatalogTool(tool, snapshot));
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
  return catalogProviderToolsForState(state, names);
}

function canResolveNativeToolReadOnly(toolCall: NativeToolCallProposal): boolean {
  return toolCall.name === 'fs.read' || toolCall.name === 'fs.list';
}

function nativeToolReadSignature(toolCall: NativeToolCallProposal): NativeToolReadSignature {
  const path = stringValue(toolCall.arguments.path)
    ?? stringValue(toolCall.arguments.resourceRef)
    ?? '.';
  const rootId = stringValue(toolCall.arguments.rootId);
  const offsetBytes = normalizedNonNegativeInteger(toolCall.arguments.offsetBytes);
  const limitBytes = normalizedPositiveInteger(toolCall.arguments.limitBytes);
  const key = stableHash(JSON.stringify({
    toolName: toolCall.name,
    rootId: rootId ?? '',
    path,
    offsetBytes: typeof offsetBytes === 'number' ? offsetBytes : null,
    limitBytes: typeof limitBytes === 'number' ? limitBytes : null,
  }));
  return {
    key,
    toolName: toolCall.name,
    path,
    ...(rootId ? { rootId } : {}),
    ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
    ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
  };
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

function nativeToolPacketContentHash(packet: ResourcePacket): string {
  return stableHash(JSON.stringify(packet.items.map((item) => ({
    status: item.status,
    path: item.path,
    absolutePath: item.absolutePath,
    contentKind: item.contentKind,
    promptContent: item.promptContent,
    contentSummary: item.contentSummary,
    truncated: item.truncated,
    originalBytes: item.originalBytes,
    returnedBytes: item.returnedBytes,
    matches: item.matches,
  }))));
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

function generatedArtifactEvidenceFromPackets(packets: ResourcePacket[]): Map<string, GeneratedArtifactEvidence> {
  const evidence = new Map<string, GeneratedArtifactEvidence>();
  for (const packet of packets) {
    for (const item of packet.items) {
      if (!item.evidenceRefs?.includes('generatedArtifactEvidence')) continue;
      const targetPath = normalizeRelativePath(item.path);
      const content = typeof item.promptContent === 'string' ? item.promptContent : undefined;
      if (!targetPath || !content) continue;
      evidence.set(comparablePath(targetPath), {
        targetPath,
        content,
        contentHash: stableHash(content),
        manifestEntryId: item.manifestEntryId,
      });
    }
  }
  return evidence;
}

function indexGeneratedArtifactEvidence(state: SessionDriverLoopRunState, packet: ResourcePacket): void {
  for (const item of packet.items) {
    if (!item.evidenceRefs?.includes('generatedArtifactEvidence')) continue;
    const targetPath = normalizeRelativePath(item.path);
    const content = typeof item.promptContent === 'string' ? item.promptContent : undefined;
    if (!targetPath || !content) continue;
    state.generatedArtifactEvidence.set(comparablePath(targetPath), {
      targetPath,
      content,
      contentHash: stableHash(content),
      manifestEntryId: item.manifestEntryId,
    });
  }
}

function generatedArtifactResourcePacketFromSuccessfulBatch(
  state: SessionDriverLoopRunState,
  batch: Record<string, unknown>,
  events: unknown[],
  packetId: string
): ResourcePacket | undefined {
  const completed = completedWorkUnitFacts(events);
  if (completed.actionIds.size === 0 && completed.targets.size === 0) return undefined;
  const codeBlocks = Array.isArray(batch.codeBlocks) ? batch.codeBlocks : [];
  const codeBlockById = new Map<string, Record<string, unknown>>();
  for (const block of codeBlocks) {
    const record = objectRecord(block);
    const id = stringValue(record?.id) ?? stringValue(record?.blockId);
    if (record && id) codeBlockById.set(id, record);
  }
  const items: ResourcePacketItem[] = [];
  for (const action of batchActionRecords(batch)) {
    const capability = actionEffectiveCapability(action);
    if (capability !== 'fs.write' && capability !== 'fs.create') continue;
    const actionId = stringValue(action.actionId) ?? stringValue(action.id);
    const args = objectRecord(action.args) ?? objectRecord(action.toolArgs);
    const sourceBlockId = stringValue(action.sourceBlockId) ?? stringValue(args?.sourceBlockId);
    const block = sourceBlockId ? codeBlockById.get(sourceBlockId) : undefined;
    const targetPath = normalizeRelativePath(
      actionFileTargetPath(action) ??
      stringValue(block?.targetPath) ??
      stringValue(block?.path)
    );
    if (!targetPath || targetPath === '.') continue;
    if (!completedActionMatches(actionId, targetPath, completed)) continue;
    const content = block ? codeBlockContent(block) : undefined;
    if (typeof content !== 'string') continue;
    const manifestEntryId = `generated-${sanitizeId(targetPath)}`;
    const absolutePath = generatedArtifactAbsolutePath(state, targetPath);
    const contentHash = stableHash(content);
    state.generatedArtifactEvidence.set(comparablePath(targetPath), {
      targetPath,
      content,
      contentHash,
      manifestEntryId,
      sourceBlockId,
      actionId,
    });
    items.push({
      requestItemId: `generated-${sanitizeId(actionId ?? targetPath)}`,
      manifestEntryId,
      readPolicy: 'autoRead',
      status: 'resolved',
      path: targetPath,
      ...(absolutePath ? { absolutePath } : {}),
      contentKind: 'fileText',
      contentSummary: `Generated artifact from completed Kernel work unit: ${targetPath}`,
      promptContent: content,
      originalBytes: utf8Bytes(content),
      returnedBytes: utf8Bytes(content),
      rangeComplete: true,
      evidenceRefs: ['generatedArtifactEvidence'],
    });
  }
  if (!items.length) return undefined;
  return {
    id: packetId,
    workspaceScopeKey: state.workspaceScopeKey,
    requestId: `${packetId}-request`,
    items,
  };
}

function generatedArtifactResourcePacketForRequest(
  state: SessionDriverLoopRunState,
  request: ResourceRequestDraft,
  packetId: string
): { packet?: ResourcePacket; remaining: ResourceRequestDraft } {
  const remainingItems: ResourceRequestDraft['items'] = [];
  const items: ResourcePacketItem[] = [];
  for (const item of request.items ?? []) {
    const evidence = generatedArtifactEvidenceForRequestItem(state, item);
    if (!evidence) {
      remainingItems.push(item);
      continue;
    }
    const absolutePath = generatedArtifactAbsolutePath(state, evidence.targetPath);
    items.push({
      requestItemId: item.id,
      manifestEntryId: evidence.manifestEntryId,
      readPolicy: 'autoRead',
      status: 'resolved',
      path: evidence.targetPath,
      ...(absolutePath ? { absolutePath } : {}),
      contentKind: 'fileText',
      contentSummary: `Run-local generated artifact evidence: ${evidence.targetPath}`,
      promptContent: evidence.content,
      originalBytes: utf8Bytes(evidence.content),
      returnedBytes: utf8Bytes(evidence.content),
      rangeComplete: true,
      evidenceRefs: ['generatedArtifactEvidence'],
    });
  }
  return {
    packet: items.length
      ? {
        id: packetId,
        workspaceScopeKey: state.workspaceScopeKey,
        requestId: request.id ?? `${packetId}-request`,
        items,
      }
      : undefined,
    remaining: {
      ...request,
      items: remainingItems,
    },
  };
}

function generatedArtifactEvidenceForRequestItem(
  state: SessionDriverLoopRunState,
  item: ResourceRequestDraft['items'][number]
): GeneratedArtifactEvidence | undefined {
  if (item.kind === 'search' || item.query?.trim()) return undefined;
  const candidates = uniqueStrings([
    stringValue(item.path),
    stringValue(item.manifestEntryId),
  ]);
  for (const candidate of candidates) {
    const resolved = resolveRequestPath(candidate, item.rootId, state.conversationRoots);
    const fallback = resolved.kind === 'resolved'
      ? resolved
      : resolveRequestPath(candidate, undefined, state.conversationRoots);
    const targetPath = fallback.kind === 'resolved'
      ? fallback.relativePath
      : normalizeRelativePath(candidate);
    if (!targetPath || targetPath === '.') continue;
    const evidence = state.generatedArtifactEvidence.get(comparablePath(targetPath));
    if (evidence) return evidence;
  }
  return undefined;
}

function completedWorkUnitFacts(events: unknown[]): { actionIds: Set<string>; targets: Set<string> } {
  const actionIds = new Set<string>();
  const targets = new Set<string>();
  for (const event of events) {
    const record = objectRecord(event);
    if (record?.kind !== 'work_unit.completed') continue;
    const workUnit = objectRecord(record.workUnit);
    const output = objectRecord(record.output);
    for (const value of [
      stringValue(record.actionId),
      stringValue(workUnit?.actionId),
      stringValue(output?.actionId),
    ]) {
      if (value) actionIds.add(value);
    }
    for (const target of kernelEventTargets(record)) {
      const normalized = normalizeRelativePath(target) ?? target;
      if (normalized && normalized !== '.') targets.add(comparablePath(normalized));
    }
  }
  return { actionIds, targets };
}

function completedActionMatches(
  actionId: string | undefined,
  targetPath: string,
  completed: { actionIds: Set<string>; targets: Set<string> }
): boolean {
  if (actionId && completed.actionIds.has(actionId)) return true;
  return completed.targets.has(comparablePath(targetPath));
}

function codeBlockContent(block: Record<string, unknown>): string | undefined {
  if (typeof block.content === 'string') return block.content;
  const lines = stringArrayValue(block.contentLines);
  return lines.length ? lines.join('\n') : undefined;
}

function generatedArtifactAbsolutePath(state: SessionDriverLoopRunState, targetPath: string): string | undefined {
  const root = state.conversationRoots.find((item) => item.primary) ?? state.conversationRoots[0];
  const base = root?.absolutePath ?? root?.displayPath;
  return base ? joinFsPath(base, targetPath) : undefined;
}

function nativeToolDuplicateResult(
  toolCall: NativeToolCallProposal,
  entry: NativeToolReadLedgerEntry
): Record<string, unknown> {
  return {
    ...nativeToolResultFromPacket(toolCall, entry.packet),
    duplicate: true,
    duplicateOfPacketId: entry.packet.id,
    duplicateContentHash: entry.contentHash,
    duplicateCount: entry.repeatCount,
    message: 'This exact read-only native tool target/range was already resolved in this provider checkpoint. Use the returned ResourcePacket facts and output a valid proposal instead of calling the same read tool again.',
  };
}

function providerStageExposesAssistantDelta(stage: string): boolean {
  return stage === 'answer_stream' || stage === 'review_final';
}

function providerStageEmitsJsonProgress(stage: string): boolean {
  return stage === 'accepted_plan_provider_call' ||
    stage === 'accepted_plan_resource_resume' ||
    stage === 'accepted_plan_resource_resume_repair' ||
    stage === 'accepted_plan_scope_repair' ||
    stage === 'accepted_plan_parent_fallback' ||
    stage === 'accepted_plan_parent_fallback_repair';
}

function providerJsonStreamProgressSummary(language: VisibleLanguage, receivedChars: number): string {
  return language === 'en-US'
    ? `Generating the executable actionBundle draft (${receivedChars} chars received).`
    : `正在生成可执行 actionBundle 草稿（已接收 ${receivedChars} 字符）。`;
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
    const currentTask = acceptedPlan.tasks.find((task) => !acceptedPlan.completedTaskIds.includes(task.taskId));
    const currentTaskOperations = objectRecord(sanitizedAcceptedPlanExecutionContext(acceptedPlan))?.currentTaskOperations;
    hints.push(
      `Accepted taskPlan active: planId=${acceptedPlan.planId}; currentTask=${currentTask?.taskId ?? 'complete'}; completedTasks=${acceptedPlan.completedTaskIds.length}/${acceptedPlan.tasks.length}. Automatic execution is allowed only for the current task when targets and capabilities stay inside the accepted plan.`,
      currentTask
        ? `Current accepted taskPlan task: taskId=${currentTask.taskId}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
        : 'Current accepted taskPlan task is complete or unavailable; return diagnostic or review-ready summary rather than expanding scope.',
      Array.isArray(currentTaskOperations) && currentTaskOperations.length
        ? `Accepted current task operations: ${JSON.stringify(currentTaskOperations)}.`
        : 'Accepted current task operations: none.',
      'Exact file operations such as fs.delete/fs.rename are authorized by exact operation grants, not by provider-declared scope fields.',
      acceptedPlan.executionRoot
        ? `Accepted taskPlan primary root: ${acceptedPlan.executionRoot.ref}. Workspace actionBundle targetPath/codeBlock paths must be relative to this root and must not include the root directory name. Absolute paths are allowed only for outside-workspace targets already reviewed in the accepted plan.`
        : 'Accepted taskPlan primary root is not explicit; use relative target paths from the authorized workspace root unless the accepted plan explicitly contains outside-workspace absolute file targets.',
      'Do not ask the user to reconfirm routine implementation batches already covered by the accepted taskPlan. If new targets, capabilities, or material technical choices are needed during accepted execution, return decisionRequest instead of an out-of-scope actionBundle.'
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

function refreshTaskExecutionState(state: SessionDriverLoopRunState): void {
  state.taskExecutionCursor = buildTaskExecutionCursor(
    state.acceptedImplementationPlan,
    state.resourcePackets,
    state.taskExecutionCursor?.lastSavepointId
  );
  state.currentTaskContext = buildCurrentTaskContext(state.acceptedImplementationPlan, state.taskExecutionCursor);
  state.taskLedger = buildAcceptedPlanTaskLedger(state.acceptedImplementationPlan);
  state.acceptedPlanPromptFrame = buildAcceptedPlanPromptFrameForContext(state.acceptedImplementationPlan, state.taskLedger);
}

function buildAcceptedPlanTaskLedger(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  failedTaskId?: string,
  skippedTaskIds: string[] = [],
  acceptedIncompleteTaskIds: string[] = []
): TaskLedgerSnapshot | undefined {
  if (!acceptedPlan) return undefined;
  const completed = new Set(acceptedPlan.completedTaskIds);
  const currentTask = acceptedPlan.tasks.find((task) =>
    !completed.has(task.taskId) &&
    task.taskId !== failedTaskId &&
    !skippedTaskIds.includes(task.taskId) &&
    !acceptedIncompleteTaskIds.includes(task.taskId)
  );
  return buildTaskLedgerSnapshot({
    planId: acceptedPlan.planId,
    runId: acceptedPlan.runId,
    tasks: acceptedPlan.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds: acceptedPlan.completedTaskIds,
    failedTaskId,
    skippedTaskIds,
    acceptedIncompleteTaskIds,
    currentTaskId: currentTask?.taskId,
  });
}

function buildAcceptedPlanPromptFrameForContext(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  taskLedger: TaskLedgerSnapshot | undefined
): AcceptedPlanPromptFrame | undefined {
  if (!acceptedPlan || !taskLedger) return undefined;
  return buildAcceptedPlanPromptFrame({
    planId: acceptedPlan.planId,
    runId: acceptedPlan.runId,
    title: acceptedPlan.title,
    summary: acceptedPlan.summary,
    taskLedger,
  });
}

function buildTaskExecutionCursor(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  resourcePackets: ResourcePacket[],
  lastSavepointId?: string
): TaskExecutionCursor | undefined {
  if (!acceptedPlan) return undefined;
  const ledger = buildAcceptedPlanTaskLedger(acceptedPlan);
  const completedTasks = new Set(acceptedPlan.completedTaskIds);
  const currentTask = acceptedPlan.tasks.find((task) => !completedTasks.has(task.taskId))
    ?? acceptedPlan.tasks[Math.max(0, acceptedPlan.batchIndex - 1)];
  const lastResourcePacketIds = resourcePackets
    .map((packet) => packet.id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .slice(-6);
  const cursorKey = [
    acceptedPlan.planId,
    currentTask?.taskId ?? 'none',
    acceptedPlan.completedTaskIds.join(','),
    lastResourcePacketIds.join(','),
    lastSavepointId ?? '',
  ].join('|');
  return {
    cursorId: `task-cursor-${stableHash(cursorKey).slice(0, 16)}`,
    planId: acceptedPlan.planId,
    currentTaskId: currentTask?.taskId,
    taskOrder: ledger?.taskOrder ?? acceptedPlan.tasks.map((task) => task.taskId),
    pendingTaskIds: ledger?.pendingTaskIds ?? [],
    completedTaskIds: [...acceptedPlan.completedTaskIds],
    lastResourcePacketIds,
    lastSavepointId,
  };
}

function buildCurrentTaskContext(
  acceptedPlan: AcceptedImplementationPlanContext | undefined,
  cursor: TaskExecutionCursor | undefined
): CurrentTaskContext | undefined {
  if (!acceptedPlan || !cursor) return undefined;
  const task = acceptedPlan.tasks.find((item) => item.taskId === cursor.currentTaskId)
    ?? acceptedPlan.tasks.find((item) => !cursor.completedTaskIds.includes(item.taskId));
  const targets = [...new Set([
    ...(task?.targets ?? []),
  ].map((item) => item.trim()).filter(Boolean))];
  const capabilities = [...new Set([
    task?.capability,
  ].filter((item): item is string => Boolean(item && item.trim())))];
  const goalParts = [
    acceptedPlan.title ?? acceptedPlan.summary ?? acceptedPlan.planId,
    task ? `task=${task.taskId}${task.title ? ` ${task.title}` : ''}` : '',
    targets.length ? `targets=${targets.join(', ')}` : '',
  ].filter(Boolean);
  return {
    goal: goalParts.join(' | '),
    taskId: task?.taskId,
    nodeId: undefined,
    taskTitle: task?.title,
    targets,
    capabilities,
    taskOrder: cursor.taskOrder,
    pendingTaskIds: cursor.pendingTaskIds,
    dependsOn: [],
    evidenceNeeds: [],
    completedTaskIds: cursor.completedTaskIds,
  };
}

function currentTaskMemoryHints(context: CurrentTaskContext | undefined): string[] {
  if (!context) return [];
  return [
    'CurrentTaskGoal:',
    context.goal,
    `CurrentTaskContext: taskId=${context.taskId ?? 'none'}; targets=${context.targets.join(', ') || 'none'}; capabilities=${context.capabilities.join(', ') || 'none'}; completedTasks=${context.completedTaskIds.length}.`,
  ];
}

function sanitizedAcceptedPlanExecutionContext(acceptedPlan: AcceptedImplementationPlanContext | undefined): Record<string, unknown> {
  if (!acceptedPlan) return {};
  const completed = new Set(acceptedPlan.completedTaskIds);
  const currentTask = acceptedPlan.tasks.find((task) => !completed.has(task.taskId));
  const currentTargets = [...new Set((currentTask?.targets ?? []).flatMap((target) => expandPlanTargetTokens(target))
    .map((target) => normalizePlanScopeIdentity(target))
    .filter((target) => target && acceptedPlanTargetListSegmentSafe(target)))];
  const currentTaskOperations = acceptedPlan.exactOperationGrants.reduce<Record<string, unknown>[]>((items, grant) => {
    if (currentTask?.taskId && grant.sourceTaskId && grant.sourceTaskId !== currentTask.taskId) return items;
    const targetPath = normalizePlanScopeIdentity(grant.targetRefPath ?? grant.targetPath);
    if (!acceptedPlanTargetListSegmentSafe(targetPath)) return items;
    items.push({
      operation: grant.operation,
      capability: grant.capability,
      targetPath,
      targetResourceKind: grant.targetResourceKind,
      recursive: grant.recursive === true,
    });
    return items;
  }, []);
  return {
    planId: acceptedPlan.planId,
    title: acceptedPlan.title ?? acceptedPlan.summary ?? acceptedPlan.planId,
    currentTask: currentTask
      ? {
          taskId: currentTask.taskId,
          title: currentTask.title,
          targets: currentTargets,
          capability: currentTask.capability,
        }
      : undefined,
    completedTaskCount: acceptedPlan.completedTaskIds.length,
    remainingTaskCount: acceptedPlan.tasks.filter((task) => !completed.has(task.taskId)).length,
    currentTaskOperations,
    primaryRoot: acceptedPlan.executionRoot?.ref,
  };
}

function lastAcceptedPlanTaskSavepointId(events: AgentEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'workflow_stage') continue;
    const payload = objectRecord(event.payload);
    if (stringValue(payload?.stage) !== 'accepted_plan.task_savepoint') continue;
    return event.id;
  }
  return undefined;
}

function acceptedPlanResourceResumeEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  cursor: TaskExecutionCursor | undefined,
  context: CurrentTaskContext | undefined,
  packet: ResourcePacket,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.resource_resume',
      status: 'completed',
      summary: `已为当前任务补充只读资源证据，Session 将从同一 task cursor 紧凑续接。`,
      runId,
      planId: accepted.planId,
      taskCursorId: cursor?.cursorId,
      currentTaskId: context?.taskId,
      targetPaths: context?.targets ?? [],
      resourcePacketId: packet.id,
      resourceItemCount: packet.items.length,
      lastResourcePacketIds: cursor?.lastResourcePacketIds ?? [],
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: 'resourceRead',
        status: 'completed',
        title: 'Accepted plan resource resume',
        summary: 'Session resolved evidence for the current accepted-plan task and will resume from a compact task checkpoint.',
        source: 'session',
        runId,
        targets: context?.targets,
      }),
    },
  };
}

function acceptedPlanTaskSavepointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  nextAccepted: AcceptedImplementationPlanContext,
  progress: AcceptedPlanBatchProgress,
  kernelEvents: unknown[],
  cursor: TaskExecutionCursor | undefined,
  context: CurrentTaskContext | undefined,
  ts: string,
  id: string
): AgentEvent {
  const complete = progress.remainingTaskIds.length === 0 && !actionBatchHasFailureOrBlocker(kernelEvents);
  const ledger = buildAcceptedPlanTaskLedger(nextAccepted);
  const promptFrame = buildAcceptedPlanPromptFrameForContext(nextAccepted, ledger);
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.task_savepoint',
      status: complete ? 'completed' : 'running',
      summary: complete
        ? '当前 accepted taskPlan 已完成全部任务清单。'
        : '当前 accepted taskPlan 已保存任务批次进度，下一批将按任务清单顺序继续。',
      runId,
      planId: accepted.planId,
      taskCursorId: cursor?.cursorId,
      taskId: context?.taskId,
      completedTaskIds: progress.completedTaskIds,
      newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
      remainingTaskIds: progress.remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger?.taskOrder ?? [],
      nextPendingTaskIds: ledger?.pendingTaskIds ?? [],
      acceptedPlanPromptFrame: promptFrame,
      targetPaths: progress.targetPaths,
      workUnitIds: progress.workUnitIds,
      kernelEventCount: kernelEvents.length,
      memoryUpdateSummary: 'SessionMemory will retain the active task focus, completed task ids, and next checkpoint as derived intent/checkpoint memory.',
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
        status: complete ? 'completed' : 'running',
        title: complete ? 'Task plan savepoint complete' : 'Task plan savepoint',
        summary: complete ? 'All accepted tasks are complete.' : 'Accepted task progress saved for the next provider checkpoint.',
        source: 'session',
        runId,
        targets: progress.targetPaths,
        itemCount: progress.newlyCompletedTaskIds.length,
      }),
    },
  };
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

// i18n 诊断结构：session-core 产出语言无关的 code + params + 英文 fallback，
// GUI 渲染时按 diagnosticCode 走 i18n 翻译，fallback 供无 i18n 消费者（CLI/日志）。
interface DiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

function diag(code: string, fallback: string, params?: Record<string, string | number>): DiagnosticInfo {
  return { code, fallback, params };
}

function resourceResolutionDiagnostic(resolution: ResourceRequestResolution): DiagnosticInfo {
  const unresolved = resolution.unresolved.join('; ');
  const ambiguous = resolution.ambiguous.join('; ');
  const roots = resolution.availableRoots.length
    ? resolution.availableRoots.map((root) => `${root.rootId} -> ${root.displayPath}`).join('\n')
    : '';
  // fallback 为中性英文成文；语言无关数据（unresolved/ambiguous/roots）作为 params 供 UI 壳本地化组装。
  const fallback = [
    'The requested resources could not be located in the current attachments or project directory; Session rejected the request.',
    unresolved ? `Unresolved: ${unresolved}` : '',
    ambiguous ? `Multiple candidate roots: ${ambiguous}` : '',
    'Available project/attachment roots:',
    roots || 'No available attachment or project directory.',
    'Please specify an explicit attachment, rootId, or relative path.',
  ].filter(Boolean).join('\n');
  return diag('resourceResolveFailed', fallback, { unresolved, ambiguous, roots });
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
  const status = item.status === 'resolved' || item.status === 'provided' || item.status === 'skipped'
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
    skipReason: typeof item.skipReason === 'string' ? item.skipReason : undefined,
    skipMessage: typeof item.skipMessage === 'string' ? item.skipMessage : undefined,
    fileClassification: objectRecord(item.fileClassification) ?? undefined,
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
        requiredAccessScopes: requiredAccessScopesFromReport(report),
        permissionBundles: permissionBundlesFromReport(report),
        interventions: gateInterventionsFromReport(report),
        executionContract: objectRecord(report.executionContract) ?? undefined,
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
    const capability = stringValue(request.capability) ?? stringValue(record.capability) ?? 'fs.write';
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
    const activity = kernelEventActivity(record, id);
    return {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: kernelFailureMessage(kind, record),
        channel: 'error',
        visibility: 'conversation',
        activity,
        kernelEvent: record,
      },
    };
  }
  const activity = kernelEventActivity(record, id);
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
      activity,
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
  const activity = resourcePacketActivity(packet, id);
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
      activity,
    },
  };
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return {
    ...input,
    targets: uniqueStrings(input.targets ?? []),
    actionIds: uniqueStrings(input.actionIds ?? []),
    workUnitIds: uniqueStrings(input.workUnitIds ?? []),
  };
}

function providerActivity(
  state: SessionDriverLoopRunState,
  stage: string,
  status: 'running' | 'completed'
): AgentConversationActivity {
  return conversationActivity({
    activityId: `provider-${stage}`,
    kind: 'providerThinking',
    status,
    title: status === 'running' ? 'Provider call running' : 'Provider call completed',
    summary: providerStageSummary(stage, status === 'running' ? 'request' : 'response', visibleLanguageForRequest(state.userRequest)),
    source: 'provider',
    runId: state.runId,
  });
}

function resourcePacketActivity(packet: ResourcePacket, activityId: string, runId?: string): AgentConversationActivity {
  const failed = packet.items.some((item) => item.status === 'error' || item.status === 'denied');
  const search = packet.items.some((item) => item.contentKind === 'searchResults');
  return conversationActivity({
    activityId,
    kind: search ? 'resourceSearch' : 'resourceRead',
    status: failed ? 'failed' : 'completed',
    title: search ? 'Search results resolved' : 'Resource context resolved',
    summary: `Kernel resolved ${packet.items.length} resource item(s).`,
    source: 'kernel',
    runId,
    targets: packet.items.flatMap((item) => [
      item.path,
      item.manifestEntryId,
    ]).filter((item): item is string => Boolean(item)),
    itemCount: packet.items.length,
  });
}

function acceptedPlanBatchActivity(
  accepted: AcceptedImplementationPlanContext,
  batch: unknown,
  status: 'running' | 'completed'
): AgentConversationActivity {
  const actions = batchActionRecords(batch);
  return conversationActivity({
    activityId: `accepted-plan-batch-${accepted.planId}-${accepted.batchIndex}-${status}`,
    kind: 'editBatchQueued',
    status,
    title: status === 'running' ? 'Submitting accepted-plan batch' : 'Accepted-plan batch submitted',
    summary: acceptedPlanBatchActivitySummary(batch),
    source: 'session',
    runId: accepted.runId,
    planId: accepted.planId,
    targets: actions.flatMap(actionTargetCandidates),
    actionIds: actions.flatMap((action) => stringValue(action.actionId) ?? stringValue(action.id) ?? []),
    itemCount: actions.length,
  });
}

function acceptedPlanBatchActivitySummary(batch: unknown): string {
  const actions = batchActionRecords(batch);
  const targetCount = uniqueStrings(actions.flatMap(actionTargetCandidates)).length;
  return `Session is submitting ${actions.length} accepted-plan action(s) for ${targetCount} target(s).`;
}

function batchActionRecords(batch: unknown): Record<string, unknown>[] {
  const record = objectRecord(batch);
  const nested = objectRecord(record?.actionBundle);
  const actions = Array.isArray(record?.actions)
    ? record.actions
    : Array.isArray(nested?.actions)
      ? nested.actions
      : [];
  return actions.flatMap((item) => objectRecord(item) ? [objectRecord(item) as Record<string, unknown>] : []);
}

function actionTargetCandidates(action: Record<string, unknown>): string[] {
  return uniqueStrings([
    actionFileTargetPath(action),
    stringValue(action.targetPath),
    ...stringArrayValue(action.resourceScope),
  ]);
}

interface KernelWorkUnitFact {
  actionId?: string;
  writeSet: string[];
  deleteSet: string[];
}

function indexKernelWorkUnitFacts(events: unknown[]): Map<string, KernelWorkUnitFact> {
  const facts = new Map<string, KernelWorkUnitFact>();
  for (const event of events) {
    const record = objectRecord(event);
    if (record?.kind !== 'work_unit.queued') continue;
    const workUnit = objectRecord(record.workUnit);
    const id = stringValue(workUnit?.id) ?? stringValue(record.workUnitId);
    if (!id) continue;
    const writeSet = uniqueStrings([
      ...stringArrayValue(record.writeSet),
      ...stringArrayValue(workUnit?.writeSet),
    ]);
    const deleteSet = uniqueStrings([
      ...stringArrayValue(record.deleteSet),
      ...stringArrayValue(workUnit?.deleteSet),
    ]);
    const fallbackTargets = kernelEventTargets(record);
    facts.set(id, {
      actionId: stringValue(record.actionId) ?? stringValue(workUnit?.actionId),
      writeSet: writeSet.length ? writeSet : fallbackTargets,
      deleteSet,
    });
  }
  return facts;
}

function enrichKernelWorkUnitRecord(
  record: Record<string, unknown>,
  facts: Map<string, KernelWorkUnitFact>
): Record<string, unknown> {
  const kind = stringValue(record.kind);
  if (!kind?.startsWith('work_unit.') || kind === 'work_unit.queued') return record;
  if (kernelEventTargets(record).length > 0) return record;
  const workUnit = objectRecord(record.workUnit);
  const workUnitId = stringValue(record.workUnitId) ?? stringValue(workUnit?.id);
  const fact = workUnitId ? facts.get(workUnitId) : undefined;
  if (!fact || (fact.writeSet.length === 0 && fact.deleteSet.length === 0 && !fact.actionId)) return record;
  const enrichedWorkUnit = {
    ...(workUnit ?? {}),
    ...(workUnitId ? { id: workUnitId } : {}),
    ...(fact.actionId && !stringValue(workUnit?.actionId) ? { actionId: fact.actionId } : {}),
    ...(fact.writeSet.length && stringArrayValue(workUnit?.writeSet).length === 0 ? { writeSet: fact.writeSet } : {}),
    ...(fact.deleteSet.length && stringArrayValue(workUnit?.deleteSet).length === 0 ? { deleteSet: fact.deleteSet } : {}),
  };
  return {
    ...record,
    ...(!stringValue(record.actionId) && fact.actionId ? { actionId: fact.actionId } : {}),
    ...(stringArrayValue(record.writeSet).length === 0 && fact.writeSet.length ? { writeSet: fact.writeSet } : {}),
    ...(stringArrayValue(record.deleteSet).length === 0 && fact.deleteSet.length ? { deleteSet: fact.deleteSet } : {}),
    workUnit: enrichedWorkUnit,
  };
}

function kernelEventActivity(
  record: Record<string, unknown>,
  activityId: string,
  fallbackRunId?: string
): AgentConversationActivity | undefined {
  const kind = stringValue(record.kind);
  if (!kind) return undefined;
  const runId = stringValue(record.runId) ?? fallbackRunId;
  const workUnit = objectRecord(record.workUnit);
  const tool = objectRecord(record.tool);
  const targets = kernelEventTargets(record);
  const workUnitIds = uniqueStrings([
    stringValue(record.workUnitId),
    stringValue(workUnit?.id),
  ]);
  const actionIds = uniqueStrings([
    stringValue(record.actionId),
    stringValue(workUnit?.actionId),
  ]);
  const toolName = stringValue(record.toolName) ?? stringValue(tool?.name) ?? stringValue(record.name);
  if (kind === 'work_unit.queued' || kind === 'action_batch.accepted') {
    return conversationActivity({
      activityId,
      kind: 'editBatchQueued',
      status: 'queued',
      title: 'Edit work queued',
      summary: kernelEventSummary(kind, record),
      source: 'kernel',
      runId,
      targets,
      actionIds,
      workUnitIds,
      itemCount: targets.length || actionIds.length || workUnitIds.length || undefined,
    });
  }
  if (kind === 'work_unit.started') {
    return conversationActivity({
      activityId,
      kind: 'editFileStarted',
      status: 'running',
      title: 'Editing target',
      summary: kernelEventSummary(kind, record),
      source: 'kernel',
      runId,
      targets,
      actionIds,
      workUnitIds,
      itemCount: targets.length || undefined,
    });
  }
  if (kind === 'work_unit.completed' || kind === 'workspace.result') {
    return conversationActivity({
      activityId,
      kind: 'editFileCompleted',
      status: 'completed',
      title: 'Edit completed',
      summary: kernelEventSummary(kind, record),
      source: 'kernel',
      runId,
      targets,
      actionIds,
      workUnitIds,
      itemCount: targets.length || undefined,
    });
  }
  if (kind === 'work_unit.failed' || kind === 'work_unit.blocked' || kind === 'proposal.rejected') {
    const error = objectRecord(record.error);
    const message = stringValue(record.message) ?? stringValue(error?.message) ?? stringValue(record.reason) ?? kernelFailureMessage(kind, record);
    return conversationActivity({
      activityId,
      kind: 'editFileFailed',
      status: kind === 'work_unit.blocked' ? 'blocked' : 'failed',
      title: kind === 'work_unit.blocked' ? 'Edit blocked' : 'Edit failed',
      summary: message,
      source: 'kernel',
      runId,
      targets,
      actionIds,
      workUnitIds,
      errorCode: stringValue(record.code) ?? stringValue(error?.code),
      errorMessage: message,
    });
  }
  if (kind === 'tool.completed' || kind === 'tool.failed') {
    const failed = kind === 'tool.failed';
    const error = objectRecord(record.error);
    const message = stringValue(record.summary) ?? stringValue(error?.message) ?? kind;
    return conversationActivity({
      activityId,
      kind: 'toolExecution',
      status: failed ? 'failed' : 'completed',
      title: failed ? 'Tool failed' : 'Tool completed',
      summary: message,
      source: 'kernel',
      runId,
      targets,
      actionIds,
      workUnitIds,
      toolName,
      errorCode: failed ? stringValue(record.code) ?? stringValue(error?.code) : undefined,
      errorMessage: failed ? message : undefined,
    });
  }
  if (kind === 'resource.packet_produced') {
    return conversationActivity({
      activityId,
      kind: 'resourceRead',
      status: 'completed',
      title: 'Resource context resolved',
      summary: kernelEventSummary(kind, record),
      source: 'kernel',
      runId,
      targets,
      itemCount: targets.length || undefined,
    });
  }
  return undefined;
}

function kernelEventTargets(record: Record<string, unknown>): string[] {
  const output = objectRecord(record.output);
  const result = objectRecord(record.result);
  const workUnit = objectRecord(record.workUnit);
  const compiledTool = objectRecord(workUnit?.compiledTool) ?? objectRecord(record.compiledTool);
  return uniqueStrings([
    stringValue(record.path),
    stringValue(record.targetPath),
    stringValue(record.normalizedTargetPath),
    stringValue(record.resourcePath),
    ...stringArrayValue(record.writeSet),
    ...stringArrayValue(record.deleteSet),
    stringValue(compiledTool?.path),
    stringValue(output?.path),
    stringValue(output?.targetPath),
    stringValue(output?.normalizedTargetPath),
    stringValue(output?.absolutePath),
    stringValue(result?.path),
    stringValue(result?.targetPath),
    stringValue(result?.normalizedTargetPath),
    ...stringArrayValue(workUnit?.writeSet),
    ...stringArrayValue(workUnit?.deleteSet),
  ]);
}

function kernelActivityDeltaType(record: Record<string, unknown>): ProjectionDelta['type'] {
  const kind = stringValue(record.kind) ?? '';
  if (kind.startsWith('work_unit.') || kind === 'workspace.result') return 'workunit_delta';
  if (kind.startsWith('tool.')) return 'tool_call_delta';
  if (kind.startsWith('resource.')) return 'resource_delta';
  return 'stage_delta';
}

function kernelActivityChannel(activity: AgentConversationActivity): ProjectionDelta['channel'] {
  if (activity.kind === 'resourceRead' || activity.kind === 'resourceSearch') return 'resource';
  if (activity.kind === 'toolExecution') return 'tool';
  if (activity.kind.startsWith('edit')) return 'workunit';
  if (activity.kind === 'providerThinking') return 'reasoning';
  return 'progress';
}

function projectionStatusForActivity(activity: AgentConversationActivity): ProjectionDelta['status'] {
  return activity.status === 'blocked' ? 'failed' : activity.status;
}

function projectionDeltaActivity(
  state: SessionDriverLoopRunState,
  delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>
): AgentConversationActivity | undefined {
  const status = activityStatusFromDelta(delta.status);
  if (!status) return undefined;
  const stage = delta.stage ?? delta.type;
  const base = {
    activityId: `${stage}-${delta.itemId ?? status}`,
    status,
    title: delta.summary ?? stage,
    summary: delta.summary ?? stage,
    source: activitySourceFromDelta(delta.source),
    runId: state.runId,
    draftId: delta.draftId,
    targets: uniqueStrings([delta.targetPath]),
  };
  if (delta.type === 'resource_delta') {
    return conversationActivity({
      ...base,
      kind: stage.includes('search') ? 'resourceSearch' : 'resourceRead',
      title: delta.summary ?? 'Resource activity',
    });
  }
  if (delta.type === 'workunit_delta') {
    return conversationActivity({
      ...base,
      kind: status === 'failed' ? 'editFileFailed' : status === 'completed' ? 'editFileCompleted' : 'editFileStarted',
      title: delta.summary ?? 'Workspace edit activity',
    });
  }
  if (delta.type === 'draft_delta' || delta.type === 'part_delta') {
    return conversationActivity({
      ...base,
      kind: 'toolExecution',
      title: delta.summary ?? 'Draft activity',
    });
  }
  return undefined;
}

function activitySourceFromDelta(source: ProjectionDelta['source'] | undefined): AgentConversationActivity['source'] {
  if (source === 'kernel' || source === 'provider' || source === 'llm') return source;
  return 'session';
}

function activityStatusFromDelta(status: ProjectionDelta['status'] | undefined): AgentConversationActivity['status'] | undefined {
  if (status === 'queued' || status === 'running' || status === 'waiting' || status === 'completed' || status === 'failed') return status;
  if (status === 'streaming') return 'running';
  if (status === 'draftReady') return 'completed';
  if (status === 'discarded' || status === 'skipped') return 'blocked';
  return undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
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

function answerProposalFromDecisionEffect(
  sessionId: string,
  runId: string,
  effect: RequirementOptionEffect,
  events: AgentEvent[],
  guidance: string | undefined,
  proposalId: string
): ProposalEnvelope {
  const accepted = recoverAcceptedPlanFromEvents(events, runId);
  const ledger = buildAcceptedPlanTaskLedger(accepted);
  const completed = ledger?.completedTaskIds.length ?? 0;
  const total = ledger?.taskOrder.length ?? 0;
  const pending = ledger?.pendingTaskIds.length ?? 0;
  const reason = effect.kind === 'finishWithAnswer'
    ? effect.reason
    : effect.kind === 'markAcceptedIncomplete'
      ? effect.reason
      : undefined;
  const lines = [
    '## 当前会话已按用户介入收口',
    '',
    '用户已要求停止继续执行并输出总结。以下内容只基于 Session ledger 与 Kernel facts 派生，不声明未发生的工具执行。',
    '',
    total ? `- 已确认任务总数：${total}` : '- 当前没有可恢复的 accepted plan 任务清单。',
    total ? `- 已完成任务：${completed}` : '',
    total ? `- 未继续执行任务：${pending}` : '',
    reason ? `- 用户介入原因：${reason}` : '',
    guidance?.trim() ? `- 用户补充说明：${guidance.trim()}` : '',
    '',
    '后续如需继续，需要重新生成或确认新的 Plan；未提交 Kernel 的任务不会被视为完成事实。',
  ].filter(Boolean);
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    proposalId,
    runId,
    sessionId,
    source: 'system',
    kind: 'answer',
    payload: {
      answer: {
        version: '1',
        format: 'markdown',
        content: lines.join('\n'),
      },
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
}

function recoverAcceptedPlanFromEvents(events: AgentEvent[], runId: string): AcceptedImplementationPlanContext | undefined {
  const plan = latestExecutablePlan(events, runId);
  if (!plan?.implementationPlan) return undefined;
  return acceptedPlanWithLatestCheckpoint(acceptedImplementationPlanContext(plan), events);
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

function finalDiagnosticEvent(sessionId: string, content: string | DiagnosticInfo, ts: string, id: string): AgentEvent {
  const info: DiagnosticInfo = typeof content === 'string'
    ? { code: 'generic', fallback: content }
    : content;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content: info.fallback,
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      diagnostic: true,
      diagnosticCode: info.code,
      ...(info.params ? { diagnosticParams: info.params } : {}),
    },
  };
}

function thinkingEvent(
  sessionId: string,
  content: string,
  ts: string,
  id: string,
  message?: { messageKey: string; messageArgs?: Record<string, string> }
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'session.provider_status',
      status: 'completed',
      summary: content,
      content,
      channel: 'progress',
      source: 'session',
      visibility: 'conversation',
      presentation: 'stageSummary',
      label: 'Session status',
      ...(message ? { messageKey: message.messageKey, messageArgs: message.messageArgs ?? {} } : {}),
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
      source: 'provider',
      visibility: 'conversation',
      presentation: 'collapsible',
      reasoningTrace: true,
      label: 'Model reasoning',
    },
  };
}

function readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  return actionBundle as unknown as ActionBundleDraft | undefined;
}

function proposalActionBundleAdmissionBatch(proposal: ProposalEnvelope): Record<string, unknown> {
  const payload = objectRecord(proposal.payload) ?? {};
  const actionBundle = objectRecord(payload.actionBundle) ?? {};
  return {
    planId: stringValue(actionBundle.id) ?? proposal.proposalId,
    actionBundle,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
  };
}

function parseAndValidateProposal(input: {
  raw: string | Record<string, unknown>;
  runId: string;
  sessionId?: string;
  source?: 'llm' | 'user' | 'system' | 'cache';
  allowBriefActionBundleUserPlan?: boolean;
}): ProposalEnvelope {
  const proposal = parseProposalEnvelope(input);
  canonicalizeWriteActionSourceBlockRefs(proposal);
  validateProposalSemantics(proposal, {
    allowBriefActionBundleUserPlan: input.allowBriefActionBundleUserPlan === true,
  });
  return proposal;
}

function canonicalizeWriteActionSourceBlockRefs(proposal: ProposalEnvelope): void {
  if (proposal.kind !== 'actionBundle') return;
  const payload = objectRecord(proposal.payload);
  const bundle = objectRecord(payload?.actionBundle);
  const codeBlocks = Array.isArray(payload?.codeBlocks) ? payload.codeBlocks : [];
  const actions = Array.isArray(bundle?.actions) ? bundle.actions : [];
  if (!payload || !bundle || !codeBlocks.length || !actions.length) return;

  const blocks = codeBlocks.flatMap((block) => {
    const record = objectRecord(block);
    const id = stringValue(record?.id) ?? stringValue(record?.blockId);
    const targetPath = stringValue(record?.targetPath) ?? stringValue(record?.path);
    if (!id || !targetPath) return [];
    return [{ id, targetPath: normalizePlanScope(targetPath) }];
  });
  if (!blocks.length) return;

  const fixes: Array<Record<string, unknown>> = [];
  for (const [index, action] of actions.entries()) {
    const record = objectRecord(action);
    if (!record) continue;
    const capability = actionEffectiveCapability(record);
    if (capability !== 'fs.write') continue;
    const args = objectRecord(record.args) ?? objectRecord(record.toolArgs);
    const existingSource = stringValue(record.sourceBlockId) ?? stringValue(args?.sourceBlockId);
    if (existingSource) continue;
    const actionKind = stringValue(record.kind);
    if (['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) continue;
    const targetPath = actionFileTargetPath(record);
    if (!targetPath) continue;
    const normalizedTarget = normalizePlanScope(targetPath);
    const matches = blocks.filter((block) => block.targetPath === normalizedTarget);
    if (matches.length !== 1) continue;

    const nextArgs = { ...(args ?? {}) };
    nextArgs.sourceBlockId = matches[0].id;
    record.args = nextArgs;
    record.toolArgs = nextArgs;
    record.sourceBlockId = matches[0].id;
    fixes.push({
      kind: 'fs_write_sourceBlockId_canonicalized',
      actionIndex: index,
      actionId: stringValue(record.actionId) ?? stringValue(record.id),
      path: normalizedTarget,
      sourceBlockId: matches[0].id,
      reason: 'unique_codeBlock_targetPath_match',
    });
  }

  if (!fixes.length) return;
  const diagnostics = objectRecord(proposal.parserDiagnostics);
  proposal.parserDiagnostics = {
    ...(diagnostics ?? {}),
    canonicalizations: [
      ...(Array.isArray(diagnostics?.canonicalizations) ? diagnostics.canonicalizations : []),
      ...fixes,
    ],
  };
}

function validateProposalSemantics(proposal: ProposalEnvelope, options?: {
  allowBriefActionBundleUserPlan?: boolean;
}): void {
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
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
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
        `codeBlocks[${index}].content must be non-empty. Empty content is allowed only with operation="createEmpty" for an explicit empty file or with patch/replace/insert operations; do not use empty .gitkeep or placeholder writes to create directories.`
      );
    }
  }
  if (totalCodeBytes > MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `codeBlocks total content is ${totalCodeBytes} bytes; reorganize the implementation by module, file section, class, or function so this actionBundle stays within the ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} byte payload budget without reducing the accepted plan scope.`
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
    const effectiveActionKind = actionKind || (action.capability === 'fs.patch' ? 'patch' : '');
    const isPatchAction = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(effectiveActionKind);
    const replacementBlockId = typeof action.replacementBlockId === 'string'
      ? action.replacementBlockId.trim()
      : '';
    if (action.capability === 'fs.delete') {
      const deleteTargetError = deleteActionTargetError(action);
      if (deleteTargetError) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${deleteTargetError}`);
      }
      if (action.sourceBlockId?.trim() || replacementBlockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] fs.delete must not reference codeBlocks/sourceBlockId.`);
      }
    }
    if (action.capability === 'fs.write' && !isPatchAction && !action.sourceBlockId?.trim()) {
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
  if (!options?.allowBriefActionBundleUserPlan) {
    validateDetailedUserPlan(userPlan);
  }
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
  const target = actionFileTargetPath(action);
  if (!target) {
    return 'fs.delete must include a concrete targetPath or resourceScope[0].';
  }
  const normalized = normalizeSlashes(target);
  if (!normalized || normalized === '.' || normalized === './') {
    return 'fs.delete target cannot be empty or the workspace root.';
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return 'fs.delete target cannot escape the primary workspace root.';
  }
  if (normalized.includes('*')) {
    return 'fs.delete target must name concrete files; wildcard cleanup is not allowed.';
  }
  if (deleteActionTargetResourceKind(action) === 'directory') {
    if (!deleteActionRecursive(action) && normalized.endsWith('/')) {
      return 'fs.delete directory target with trailing slash must set recursive=true or use the normalized directory path.';
    }
    return undefined;
  }
  if (normalized.endsWith('/')) {
    return 'fs.delete directory target must set targetKind="directory" and recursive=true when deleting a directory tree.';
  }
  return undefined;
}

function deleteActionTargetResourceKind(action: {
  targetResourceKind?: unknown;
  targetKind?: unknown;
  toolArgs?: unknown;
  args?: unknown;
}): 'file' | 'directory' | undefined {
  const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  const value = stringValue(action.targetResourceKind)
    ?? stringValue(action.targetKind)
    ?? stringValue(toolArgs?.targetResourceKind)
    ?? stringValue(toolArgs?.targetKind);
  if (value === 'directory' || value === 'dir') return 'directory';
  if (value === 'file') return 'file';
  return undefined;
}

function deleteActionRecursive(action: { recursive?: unknown; toolArgs?: unknown; args?: unknown }): boolean {
  const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  return action.recursive === true || toolArgs?.recursive === true;
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
  const kernelPlan = renderKernelExecutionContractPlan(userPlan, report);
  const overlayPayload = interactionOverlayProjection(state.interactionOverlay);
  return {
    id,
    sessionId: state.sessionId,
    ts,
    kind: 'plan_card',
    payload: {
      title: 'Plan',
      summary: kernelPlan.summary,
      content: kernelPlan.content,
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
      ...overlayPayload,
      actionBundle,
      codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
      commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
      expectedValidation: typeof payload.expectedValidation === 'string' ? payload.expectedValidation : '',
      reviewGuide: typeof payload.reviewGuide === 'string' ? payload.reviewGuide : '',
      planReviewReport: report,
      requiredFileOperations: requiredFileOperationsFromReport(report),
      requiredAccessScopes: requiredAccessScopesFromReport(report),
      executionContract: objectRecord(report?.executionContract) ?? undefined,
      permissionBundles: permissionBundlesFromReport(report),
      interventions: gateInterventionsFromReport(report),
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
  const overlayPayload = interactionOverlayProjection(state.interactionOverlay);
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
      ...overlayPayload,
      taskPlan: implementationPlan,
      implementationPlan,
      requiredAccessScopes: accessScopesFromImplementationPlan(implementationPlan),
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

function acceptedPlanReviewNeedsRepair(report: Record<string, unknown>): boolean {
  if (planReviewNeedsRepair(report)) return true;
  if (report.status !== 'needsRevision') return false;
  const diagnostics = planReviewDiagnostics(report).join('\n').toLowerCase();
  if (!diagnostics) return false;
  return (
    (diagnostics.includes('access scope') || diagnostics.includes('accessscope')) &&
    (
      diagnostics.includes('workspace root') ||
      diagnostics.includes('root scope') ||
      diagnostics.includes('path=\".\"') ||
      diagnostics.includes('path .') ||
      diagnostics.includes('must not be the workspace root')
    )
  );
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
  const diagnostics = planReviewDiagnostics(report);
  return diagnostics.filter(Boolean).join('; ') || 'Plan review did not pass.';
}

function planReviewDiagnostics(report: Record<string, unknown>): string[] {
  const denied = Array.isArray(report.deniedReasons)
    ? report.deniedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const blocked = Array.isArray(report.blockedReasons)
    ? report.blockedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
  const findings = Array.isArray(report.findings)
    ? report.findings.flatMap((finding) => {
      const record = objectRecord(finding);
      return [
        stringValue(record?.code),
        stringValue(record?.message),
        stringValue(record?.summary),
        stringValue(record?.description),
      ].filter((item): item is string => Boolean(item));
    })
    : [];
  return [...denied, ...blocked, ...findings, summary].filter(Boolean);
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

function renderKernelExecutionContractPlan(
  userPlan: string,
  report: Record<string, unknown> | undefined
): { summary: string; content: string } {
  const status = stringValue(report?.status) ?? 'pending';
  const kernelSummary = stringValue(report?.kernelGeneratedPermissionSummary)
    ?? `Kernel gate status=${status}.`;
  const contract = objectRecord(report?.executionContract);
  const operations = kernelExecutionOperationsFromReport(report);
  const bundles = permissionBundlesFromReport(report);
  const interventions = gateInterventionsFromReport(report);
  const diagnostics = [
    ...stringArrayValue(contract?.diagnostics),
    ...stringArrayValue(report?.blockedReasons),
    ...stringArrayValue(report?.deniedReasons),
  ];
  const sections = [
    '# Kernel 执行合约',
    '',
    '## 门禁状态',
    `- 状态：${status}`,
    `- 摘要：${kernelSummary}`,
    contract?.id ? `- 合约：${String(contract.id)}` : undefined,
    '',
    '## 将发生的操作',
    operations.length
      ? operations.map((operation) => `- ${operation.operation} ${operation.targetPath} (${operation.capability})`).join('\n')
      : '- 当前 Kernel report 未列出可执行文件操作。',
    '',
    '## 权限门禁',
    bundles.length
      ? bundles.map((bundle) => {
        const targets = bundle.targets.length ? `；目标：${bundle.targets.join(', ')}` : '';
        return `- ${bundle.capability} / ${bundle.resourceKind} / ${bundle.riskLevel}${targets}`;
      }).join('\n')
      : '- 当前合约没有额外权限 bundle。',
    '',
    '## 用户介入',
    interventions.length
      ? interventions.map((item) => `- ${item.interventionKind}: ${item.summary}`).join('\n')
      : '- 无额外用户介入项。',
    diagnostics.length
      ? '\n## Kernel 诊断\n' + [...new Set(diagnostics)].map((item) => `- ${item}`).join('\n')
      : undefined,
    '',
    '## LLM 说明',
    userPlan,
  ].filter((item): item is string => typeof item === 'string');
  return {
    summary: kernelSummary,
    content: sections.join('\n'),
  };
}

interface KernelExecutionOperationProjection {
  operation: string;
  targetPath: string;
  capability: string;
}

function kernelExecutionOperationsFromReport(
  report: Record<string, unknown> | undefined
): KernelExecutionOperationProjection[] {
  const contract = objectRecord(report?.executionContract);
  const operations = Array.isArray(contract?.operations) ? contract.operations : [];
  const fromContract = operations.flatMap((item): KernelExecutionOperationProjection[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const operation = stringValue(record.operation);
    const targetPath = stringValue(record.targetPath);
    const capability = stringValue(record.capability);
    return operation && targetPath && capability ? [{ operation, targetPath, capability }] : [];
  });
  return fromContract.length ? fromContract : requiredFileOperationsFromReport(report);
}

interface PermissionBundleProjection {
  id: string;
  capability: string;
  resourceKind: string;
  resourcePath?: string;
  targets: string[];
  operationIds: string[];
  riskLevel: string;
  summary: string;
  expiresAfter?: string;
}

function permissionBundlesFromReport(
  report: Record<string, unknown> | undefined
): PermissionBundleProjection[] {
  const direct = Array.isArray(report?.permissionBundles) ? report.permissionBundles : [];
  const contract = objectRecord(report?.executionContract);
  const contractBundles = Array.isArray(contract?.permissionBundles) ? contract.permissionBundles : [];
  const source = direct.length ? direct : contractBundles;
  return source.flatMap((item): PermissionBundleProjection[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const id = stringValue(record.id);
    const capability = stringValue(record.capability);
    const resourceKind = stringValue(record.resourceKind);
    if (!id || !capability || !resourceKind) return [];
    return [{
      id,
      capability,
      resourceKind,
      resourcePath: stringValue(record.resourcePath),
      targets: stringArrayValue(record.targets),
      operationIds: stringArrayValue(record.operationIds),
      riskLevel: stringValue(record.riskLevel) ?? 'unknown',
      summary: stringValue(record.summary) ?? `Kernel requires ${capability}.`,
      expiresAfter: stringValue(record.expiresAfter),
    }];
  });
}

interface GateInterventionProjection {
  id: string;
  interventionKind: string;
  status: string;
  summary: string;
  capability?: string;
  permissionBundleId?: string;
  options: string[];
}

function gateInterventionsFromReport(
  report: Record<string, unknown> | undefined
): GateInterventionProjection[] {
  const direct = Array.isArray(report?.interventions) ? report.interventions : [];
  const contract = objectRecord(report?.executionContract);
  const contractInterventions = Array.isArray(contract?.interventions) ? contract.interventions : [];
  const source = direct.length ? direct : contractInterventions;
  return source.flatMap((item): GateInterventionProjection[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const id = stringValue(record.id);
    const interventionKind = stringValue(record.interventionKind);
    const status = stringValue(record.status);
    const summary = stringValue(record.summary);
    if (!id || !interventionKind || !status || !summary) return [];
    return [{
      id,
      interventionKind,
      status,
      summary,
      capability: stringValue(record.capability),
      permissionBundleId: stringValue(record.permissionBundleId),
      options: stringArrayValue(record.options),
    }];
  });
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
  interactionOverlay?: InteractionOverlayContext;
}

interface RecoveredAcceptedPlanContext {
  plan: SessionPlanContext;
  acceptedPlan: AcceptedImplementationPlanContext;
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

interface ReadableReviewChangedFile {
  path: string;
  operation: string;
  status: 'completed' | 'failed' | 'blocked' | 'unknown';
  actionId?: string;
  workUnitId?: string;
  toolFactIds?: string[];
  failureClassification?: string;
  failureReason?: string;
  summary: string;
  messageKey: 'review.changedFile';
  messageArgs: Record<string, string>;
  auditRef?: string;
  diffRef?: string;
}

interface ReadableReviewSummary {
  schemaVersion: 'deepcode.session.readable-review.v1';
  changedFiles: ReadableReviewChangedFile[];
  operationCounts: Record<string, number>;
  auditRefs: string[];
  developerDetailsAvailable: boolean;
  messageKey: 'review.summary';
  messageArgs: Record<string, string>;
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

function sessionProviderAllowedProposals(allowed: string[], state: SessionDriverLoopRunState): string[] {
  const merged = new Set(allowed);
  if (state.acceptedImplementationPlan) {
    merged.delete('taskPlan');
    merged.delete('implementationPlan');
    for (const kind of ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']) merged.add(kind);
  } else {
    merged.add('taskPlan');
  }
  return [...merged];
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

function recoverAcceptedPlanFromOverlay(
  input: SessionDecisionResolverInput,
  events: AgentEvent[],
  overlay: InteractionOverlayContext | undefined
): RecoveredAcceptedPlanContext | undefined {
  const planId = overlay?.acceptedPlanId;
  if (!planId) return undefined;
  const plan = (overlay.acceptedPlanRunId ? findPlanCard(events, overlay.acceptedPlanRunId, planId) : null)
    ?? findPlanCard(events, undefined, planId);
  if (!plan?.implementationPlan) return undefined;
  const executionRoot = acceptedPlanExecutionRootFromDecision(input, events);
  let acceptedPlan = acceptedPlanWithLatestCheckpoint(
    acceptedImplementationPlanContext(plan, input.interventionLevel, executionRoot),
    events
  );
  const overlayCompletedTaskIds = overlay.acceptedCompletedTaskIds ?? [];
  if (overlayCompletedTaskIds.length) {
    acceptedPlan = acceptedPlanAfterBatch(acceptedPlan, [
      ...new Set([...acceptedPlan.completedTaskIds, ...overlayCompletedTaskIds]),
    ]);
  }
  return { plan, acceptedPlan };
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
  const implementationPlan = objectRecord(payload.taskPlan) ?? objectRecord(payload.implementationPlan) ?? undefined;
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
    interactionOverlay: interactionOverlayFromPayload(payload),
  };
}

function proposalEnvelopeFromPlanContext(plan: SessionPlanContext): ProposalEnvelope {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    proposalId: plan.proposalId ?? plan.planId,
    runId: plan.runId,
    sessionId: plan.sessionId,
    source: 'system',
    kind: 'actionBundle',
    narration: plan.userPlan,
    payload: {
      userPlan: plan.userPlan,
      actionBundle: plan.actionBundle,
      codeBlocks: plan.codeBlocks,
      commandBlocks: plan.commandBlocks,
      expectedValidation: plan.expectedValidation,
      reviewGuide: plan.reviewGuide,
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
}

function interactionOverlayFromRequirementDecision(confirmation: AgentEvent, decision: AgentEvent): InteractionOverlayContext | undefined {
  const confirmationPayload = objectRecord(confirmation.payload) ?? {};
  const overlay = interactionOverlayFromPayload(confirmationPayload);
  if (!overlay) return undefined;
  return {
    ...overlay,
    resumedFromDecisionId: decision.id,
  };
}

function interactionOverlayFromPayload(payload: Record<string, unknown> | undefined): InteractionOverlayContext | undefined {
  if (!payload || payload.interactionOverlay !== true) return undefined;
  const parentRunId = stringValue(payload.parentRunId);
  const parentPhase = sessionTurnPhaseValue(payload.parentPhase);
  const interactionRunId = stringValue(payload.interactionRunId) ?? stringValue(payload.runId);
  const interactionId = stringValue(payload.interactionId)
    ?? stringValue(payload.requirementId)
    ?? stringValue(payload.targetId);
  if (!parentRunId || !parentPhase || !interactionRunId || !interactionId) return undefined;
  return {
    parentRunId,
    parentPhase,
    interactionRunId,
    interactionId,
    sourceInteractionId: stringValue(payload.sourceInteractionId) ?? interactionId,
    resumedFromDecisionId: stringValue(payload.resumedFromDecisionId),
    acceptedPlanId: stringValue(payload.acceptedPlanId),
    acceptedPlanRunId: stringValue(payload.acceptedPlanRunId),
    acceptedCurrentTaskId: stringValue(payload.acceptedCurrentTaskId),
    acceptedCompletedTaskIds: stringArrayValue(payload.acceptedCompletedTaskIds),
  };
}

function interactionOverlayProjection(overlay: InteractionOverlayContext | undefined): Record<string, unknown> {
  if (!overlay) return {};
  return {
    interactionOverlay: true,
    parentRunId: overlay.parentRunId,
    parentPhase: overlay.parentPhase,
    interactionRunId: overlay.interactionRunId,
    interactionId: overlay.interactionId,
    sourceInteractionId: overlay.sourceInteractionId ?? overlay.interactionId,
    resumedFromDecisionId: overlay.resumedFromDecisionId,
    acceptedPlanId: overlay.acceptedPlanId,
    acceptedPlanRunId: overlay.acceptedPlanRunId,
    acceptedCurrentTaskId: overlay.acceptedCurrentTaskId,
    acceptedCompletedTaskIds: overlay.acceptedCompletedTaskIds,
  };
}

function sessionTurnPhaseValue(value: unknown): SessionTurnPhase | undefined {
  const phase = stringValue(value);
  if (
    phase === 'context_reading' ||
    phase === 'provider_proposing' ||
    phase === 'waiting_plan_review' ||
    phase === 'waiting_permission' ||
    phase === 'executing_accepted_plan' ||
    phase === 'executing' ||
    phase === 'waiting_review' ||
    phase === 'completed' ||
    phase === 'failed' ||
    phase === 'cancelled'
  ) {
    return phase;
  }
  return undefined;
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
  return events.some((event, index) => {
    if (event.kind !== 'plan_review') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    const runId = stringValue(payload.runId);
    const planId = stringValue(payload.planId);
    if (runId !== plan.runId || (planId && !aliases.has(planId))) return false;
    if (status === 'rejected' || status === 'needsRevision') return true;
    return acceptedPlanExecutionConsumed(events, plan, aliases, index);
  });
}

function acceptedPlanExecutionConsumed(
  events: AgentEvent[],
  plan: SessionPlanContext,
  aliases: Set<string>,
  acceptedIndex: number
): boolean {
  for (let index = acceptedIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    const payload = objectRecord(event.payload) ?? {};
    const kernelEvent = objectRecord(payload.kernelEvent);
    const runId = stringValue(payload.runId) ?? stringValue(kernelEvent?.runId);
    if (runId && runId !== plan.runId) continue;
    const owner = objectRecord(payload.decisionOwner);
    const batch = objectRecord(kernelEvent?.batch);
    const planId = stringValue(payload.planId)
      ?? stringValue(owner?.planId)
      ?? stringValue(kernelEvent?.planId)
      ?? stringValue(batch?.planId);
    if (planId && !aliases.has(planId)) continue;

    if (event.kind === 'review_summary') return true;
    if (event.kind === 'permission_request') return true;
    if (event.kind === 'error') return true;

    if (event.kind === 'session_run_state') {
      const status = stringValue(payload.status);
      const reason = stringValue(payload.reason);
      if (status === 'failed' || status === 'cancelled' || status === 'completed') return true;
      if (reason === 'permission' || reason === 'review' || reason === 'work_unit_failed') return true;
      continue;
    }

    const stage = stringValue(payload.stage);
    if (stage === 'accepted_plan.action_batch_submit' || stage === 'accepted_plan.batch_failed') return true;

    const kernelKind = stringValue(kernelEvent?.kind) ?? stringValue(payload.kind);
    if (
      kernelKind === 'action_batch.accepted' ||
      kernelKind === 'permission.requested' ||
      kernelKind?.startsWith('work_unit.')
    ) {
      return true;
    }
  }
  return false;
}

function acceptedPlanTaskTargets(record: Record<string, unknown>): string[] {
  const rawTargets = [
    ...stringArrayValue(record.target),
    ...stringArrayValue(record.targets),
    ...stringArrayValue(record.targetPath),
    ...stringArrayValue(record.targetPaths),
    ...acceptedPlanTaskFileOperationTargets(record),
  ];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const target of rawTargets.flatMap(expandAcceptedPlanTargetValue)) {
    const normalized = normalizePlanScope(target);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
  }
  return targets;
}

function acceptedPlanTaskFileOperationTargets(record: Record<string, unknown>): string[] {
  const operations = Array.isArray(record.fileOperations) ? record.fileOperations : [];
  const targets: string[] = [];
  for (const operation of operations) {
    const item = objectRecord(operation);
    if (!item) continue;
    const target = stringValue(item.targetPath)
      ?? stringValue(item.path)
      ?? fileTargetRefPath(item.targetRef);
    if (target) targets.push(target);
  }
  return targets;
}

function expandAcceptedPlanTargetValue(value: string): string[] {
  const normalized = normalizePlanScope(value);
  if (!normalized) return [];
  if (!normalized.includes(',')) return [normalized];
  const parts = normalized
    .split(',')
    .map((part) => normalizePlanScope(part))
    .filter(Boolean);
  if (parts.length <= 1) return [normalized];
  if (!parts.every(acceptedPlanTargetListSegmentSafe)) return [normalized];
  return parts;
}

function acceptedPlanTargetListSegmentSafe(value: string): boolean {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return false;
  if (normalized.includes(',') || normalized.includes('*')) return false;
  if (normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (isAbsolutePath(normalized)) return normalized.replace(/\/+$/, '').length > 1;
  return true;
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
    const legacyDependencies = stringArrayValue(record.dependencies)
      .concat(stringArrayValue(record.dependsOn))
      .map(normalizePlanScope)
      .filter(Boolean);
    const conflictKeys = stringArrayValue(record.conflictKeys)
      .map(normalizePlanScope)
      .filter(Boolean);
    return [{
      taskId,
      title: stringValue(record.title),
      capability: stringValue(record.capability),
      targets: acceptedPlanTaskTargets(record),
      dependencies: legacyDependencies,
      conflictKeys,
      batchKind: executionSliceRoleValue(record.batchKind) ?? executionSliceRoleValue(record.role),
      role: executionSliceRoleValue(record.batchKind) ?? executionSliceRoleValue(record.role),
    }];
  });
  const capabilities = [...new Set(taskContexts.map((task) => task.capability).filter((item): item is string => Boolean(item)))];
  const targetScopes = [...new Set(taskContexts.flatMap((task) => task.targets).filter(Boolean))];
  const exactOperationGrants = [
    ...exactOperationGrantsFromImplementationPlan(rawPlan, executionRoot),
    ...exactOperationGrantsFromPlanReviewReport(plan.planReviewReport, executionRoot),
  ];
  const accessScopes = [
    ...accessScopesFromImplementationPlan(rawPlan),
    ...requiredAccessScopesFromReport(plan.planReviewReport),
  ];
  const acceptedCapabilities = [...new Set([
    ...capabilities,
    ...exactOperationGrants.map((grant) => grant.capability),
    ...accessScopes.flatMap((scope) => scope.capabilities),
  ].filter(Boolean))];
  return {
    planId: plan.planId,
    runId: plan.runId,
    title: stringValue(rawPlan.title),
    summary: stringValue(rawPlan.summary),
    tasks: taskContexts,
    capabilities: acceptedCapabilities,
    targetScopes,
    exactOperationGrants,
    accessScopes,
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

function acceptedPlanReadOnlyReviewContext(
  state: SessionDriverLoopRunState,
  accepted: AcceptedImplementationPlanContext,
  packet: ResourcePacket,
  completion: AcceptedPlanReadOnlyResourceCompletion
): SessionPlanContext {
  const targets = completion.coveredTargets.join(', ');
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    planId: accepted.planId,
    proposalId: `${accepted.planId}:read-only-validation`,
    userPlan: targets
      ? `Read-only validation evidence resolved for accepted targets: ${targets}.`
      : 'Read-only validation evidence resolved for the accepted plan.',
    actionBundle: {
      version: '1',
      id: `${accepted.planId}:read-only-validation`,
      goal: 'Read-only validation evidence satisfied the accepted task.',
      actions: [],
      validationExpectations: [{
        id: 'read-only-resource-validation',
        description: `ResourcePacket ${packet.id} resolved the read-only evidence required by the accepted task.`,
      }],
      reviewExpectations: [{
        id: 'review-read-only-validation',
        description: 'Review the resolved resource evidence and accepted-plan checkpoint.',
      }],
    },
    codeBlocks: [],
    commandBlocks: [],
    expectedValidation: `ResourcePacket ${packet.id} resolved the read-only evidence for the accepted task.`,
    reviewGuide: 'Review the resolved ResourcePacket evidence and accepted-plan checkpoint.',
    implementationPlan: accepted.rawPlan,
  };
}

type NormalizedAcceptedPlanKernelBatch =
  | {
    ok: true;
    batch: {
    planId: string;
    contractId?: string;
    actionBundle: Record<string, unknown>;
    codeBlocks: unknown[];
    commandBlocks: unknown[];
    };
    reasons: [];
  }
  | {
    ok: false;
    reasons: string[];
  };

function normalizeAcceptedPlanKernelBatch(
  planId: string,
  plan: SessionPlanContext,
  accepted?: AcceptedImplementationPlanContext
): NormalizedAcceptedPlanKernelBatch {
  const actionBundle = objectRecord(plan.actionBundle);
  const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
  const codeBlocks = plan.codeBlocks.map((block) => objectRecord(block) ? { ...(objectRecord(block) ?? {}) } : block);
  const commandBlocks = [...plan.commandBlocks];
  const codeBlockById = new Map<string, Record<string, unknown>>();
  const reasons: string[] = [];

  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    if (!record) continue;
    const id = stringValue(record.id) ?? stringValue(record.blockId);
    if (!id) continue;
    record.id = id;
    record.blockId = stringValue(record.blockId) ?? id;
    const path = acceptedPlanConcreteFileOperationTarget(
      stringValue(record.targetPath) ?? stringValue(record.path) ?? '',
      accepted
    );
    if (path) {
      record.targetPath = path;
      record.path = stringValue(record.path) ?? path;
    }
    codeBlocks[index] = record;
    codeBlockById.set(id, record);
  }

  const normalizedActions = actions.map((action, index) => {
    const record = objectRecord(action);
    if (!record) {
      reasons.push(`actionBundle.actions[${index}] 不是对象，不能提交 Kernel。`);
      return action;
    }
    const next = { ...record };
    const capability = stringValue(next.capability);
    const kind = stringValue(next.kind);
    if (capability === 'fs.delete') {
      next.kind = kind ?? 'delete';
      const deleteGrant = acceptedPlanExactOperationGrantForAction(next, accepted);
      const target = acceptedPlanConcreteDeleteOperationTarget(
        actionFileTargetPath(next) ?? '',
        accepted,
        deleteGrant
      );
      if (!target) {
        reasons.push(`actionBundle.actions[${index}] fs.delete 缺少可执行的具体目标 targetPath/resourceScope。`);
      } else {
        next.targetPath = target;
        next.resourceScope = [target];
        next.targetRef = objectRecord(next.targetRef) ?? fileTargetRefFromPath(target);
        const targetResourceKind = deleteActionTargetResourceKind(next) ?? deleteGrant?.targetResourceKind;
        if (targetResourceKind === 'directory') {
          next.targetKind = 'directory';
          next.targetResourceKind = 'directory';
          next.recursive = deleteActionRecursive(next) || deleteGrant?.recursive === true;
        }
      }
      return next;
    }

    if (capability !== 'fs.write' && capability !== 'fs.patch') {
      return next;
    }

    next.kind = kind ?? (capability === 'fs.patch' ? 'patch' : 'write');
    const patchLike = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(String(next.kind));
    const blockRef = stringValue(next.replacementBlockId) ?? stringValue(next.sourceBlockId);
    if (!blockRef) {
      reasons.push(`actionBundle.actions[${index}] ${capability} 缺少 sourceBlockId/replacementBlockId。`);
      return next;
    }
    const block = codeBlockById.get(blockRef);
    if (!block) {
      reasons.push(`actionBundle.actions[${index}] 引用的 codeBlock "${blockRef}" 不存在。`);
      return next;
    }
    const target = acceptedPlanConcreteFileOperationTarget(
      actionFileTargetPath(next) ??
      stringValue(block.targetPath) ??
      stringValue(block.path) ??
      '',
      accepted
    );
    if (!target) {
      reasons.push(`actionBundle.actions[${index}] ${capability} 缺少可执行的文件 targetPath/resourceScope。`);
      return next;
    }
    next.targetPath = target;
    next.targetRef = objectRecord(next.targetRef) ?? fileTargetRefFromPath(target);
    const existingScope = stringArrayValue(next.resourceScope)
      .map((scope) => acceptedPlanConcreteFileOperationTarget(scope, accepted))
      .filter((scope): scope is string => Boolean(scope));
    next.resourceScope = existingScope.length ? existingScope : [target];
    block.targetPath = stringValue(block.targetPath) ?? target;
    block.path = stringValue(block.path) ?? target;
    if (patchLike && !stringValue(next.replacementBlockId)) {
      next.replacementBlockId = blockRef;
    } else if (!stringValue(next.sourceBlockId)) {
      next.sourceBlockId = blockRef;
    }
    return next;
  });

  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  return {
    ok: true,
    reasons: [],
    batch: {
      planId,
      contractId: kernelExecutionContractId(plan.planReviewReport),
      actionBundle: {
        ...(actionBundle ?? {}),
        actions: normalizedActions,
      },
      codeBlocks,
      commandBlocks,
    },
  };
}

function acceptedPlanBatchPreflightAudit(batch: Record<string, unknown>): Record<string, unknown> {
  return {
    actionCount: batchActionRecords(batch).length,
    actions: batchActionRecords(batch).map((action) => ({
      actionId: stringValue(action.actionId) ?? stringValue(action.id),
      toolId: stringValue(action.toolId),
      capability: actionEffectiveCapability(action),
      kind: stringValue(action.kind),
      targetRef: objectRecord(action.targetRef) ?? stringValue(action.targetRef),
      targetPath: stringValue(action.targetPath),
      targetKind: stringValue(action.targetKind) ?? stringValue(action.targetResourceKind),
      recursive: action.recursive === true,
      resourceScope: stringArrayValue(action.resourceScope),
      sourceBlockId: stringValue(action.sourceBlockId),
      replacementBlockId: stringValue(action.replacementBlockId),
    })),
  };
}

function acceptedPlanDeletePreflightReasons(
  batch: Record<string, unknown>,
  resourcePackets: ResourcePacket[] = []
): string[] {
  const reasons: string[] = [];
  for (const [index, action] of batchActionRecords(batch).entries()) {
    if (actionEffectiveCapability(action) !== 'fs.delete') continue;
    const target = actionFileTargetPath(action);
    const normalized = target ? normalizePlanScope(target) : undefined;
    if (!normalized || normalized === '.' || normalized === './') {
      reasons.push(`actionBatch.actions[${index}] fs.delete 缺少具体目标 targetPath/resourceScope。`);
    } else {
      const targetResourceKind = deleteActionTargetResourceKind(action);
      const normalizedDirectory = normalizePlanScope(normalized).replace(/\/+$/, '');
      const resourcePacketSaysDirectory = resourcePacketsContainDirectoryPath(resourcePackets, normalizedDirectory);
      if ((normalized.endsWith('/') || resourcePacketSaysDirectory) && targetResourceKind !== 'directory') {
        reasons.push(`actionBatch.actions[${index}] fs.delete target ${normalizedDirectory} 是目录；目录删除必须显式设置 targetKind="directory"。`);
      } else if (targetResourceKind === 'directory' && !deleteActionRecursive(action)) {
        reasons.push(`actionBatch.actions[${index}] fs.delete directory target ${normalizedDirectory} 必须显式设置 recursive=true，或改为删除空目录语义。`);
      }
    }
    if (stringValue(action.sourceBlockId) || stringValue(action.replacementBlockId)) {
      reasons.push(`actionBatch.actions[${index}] fs.delete 不得引用 codeBlock。`);
    }
  }
  return [...new Set(reasons)];
}

function resourcePacketsContainDirectoryPath(resourcePackets: ResourcePacket[], targetPath: string): boolean {
  const target = normalizePlanScopeIdentity(targetPath);
  if (!target) return false;
  for (const packet of resourcePackets) {
    const items = Array.isArray(packet.items) ? packet.items : [];
    for (const item of items) {
      const record = objectRecord(item);
      if (!record) continue;
      if (resourceNodeListContainsDirectoryPath(record.nodes, target)) return true;
    }
  }
  return false;
}

function resourceNodeListContainsDirectoryPath(value: unknown, targetPath: string): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    const node = objectRecord(item);
    if (!node) continue;
    if (stringValue(node.type) === 'directory' && normalizePlanScopeIdentity(stringValue(node.path) ?? '') === targetPath) {
      return true;
    }
    if (resourceNodeListContainsDirectoryPath(node.children, targetPath)) return true;
  }
  return false;
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
  const batchTargets = acceptedPlanProposalTargetScopes(proposal, accepted);
  for (const target of batchTargets) {
    const targetError = acceptedPlanRelativeTargetError(target, accepted);
    if (targetError) reasons.push(targetError);
  }
  for (const action of actionBundle.actions ?? []) {
    const capability = actionEffectiveCapability(action as unknown as Record<string, unknown>);
    if (!acceptedPlanAutoExecutableCapability(capability)) {
      reasons.push(`能力 ${capability || '[empty]'} 需要单独用户介入，不能在 accepted taskPlan 后自动执行。`);
      continue;
    }
    if (!acceptedPlanCapabilitySetAllows(allowedCapabilities, capability)) {
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
      if (!scopeCoveredByAcceptedPlanForCapability(scope, capability, accepted)) {
        reasons.push(`目标 ${scope} 超出已确认 implementationPlan 的 target 范围。`);
      }
    }
  }
  reasons.push(...fileOperationFreshnessValidationReasons(accepted, proposal, resourcePackets));
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function canonicalizeAcceptedPlanExecutionAccessScopes(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope
): AcceptedPlanAccessScopeCanonicalizationResult {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  const base = {
    proposal,
    changed: false,
    removedAccessScopes: [] as RemovedAcceptedPlanAccessScope[],
    actionTargets: acceptedPlanProposalTargetScopes(proposal, accepted).map((target) => target.normalized),
  };
  if (!payload || !actionBundle) return base;

  const topLevel = canonicalizeAcceptedPlanAccessScopeArray(actionBundle.accessScopes, 'actionBundle.accessScopes');
  let nextActionBundle: Record<string, unknown> | undefined;
  if (topLevel.changed) {
    nextActionBundle = { ...actionBundle };
    if (topLevel.kept.length) {
      nextActionBundle.accessScopes = topLevel.kept;
    } else {
      delete nextActionBundle.accessScopes;
    }
  }

  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const nextActions = actions.map((action, actionIndex) => {
    const record = objectRecord(action);
    if (!record) return action;
    const actionScopes = canonicalizeAcceptedPlanAccessScopeArray(
      record.accessScopes,
      `actionBundle.actions[${actionIndex}].accessScopes`
    );
    if (!actionScopes.changed) return action;
    if (!nextActionBundle) nextActionBundle = { ...actionBundle };
    const nextAction = { ...record };
    if (actionScopes.kept.length) {
      nextAction.accessScopes = actionScopes.kept;
    } else {
      delete nextAction.accessScopes;
    }
    topLevel.removed.push(...actionScopes.removed);
    return nextAction;
  });

  if (!topLevel.changed && topLevel.removed.length === 0) return base;
  if (!nextActionBundle) nextActionBundle = { ...actionBundle };
  nextActionBundle.actions = nextActions;
  return {
    proposal: {
      ...proposal,
      payload: {
        ...payload,
        actionBundle: nextActionBundle,
      },
    },
    changed: true,
    removedAccessScopes: topLevel.removed,
    actionTargets: base.actionTargets,
  };
}

function canonicalizeAcceptedPlanAccessScopeArray(
  value: unknown,
  source: string
): { kept: unknown[]; removed: RemovedAcceptedPlanAccessScope[]; changed: boolean } {
  if (!Array.isArray(value)) return { kept: [], removed: [], changed: false };
  const kept: unknown[] = [];
  const removed: RemovedAcceptedPlanAccessScope[] = [];
  for (const [index, scope] of value.entries()) {
    const reason = invalidAcceptedPlanExecutionAccessScopeReason(scope);
    if (reason) {
      const record = objectRecord(scope);
      removed.push({
        index,
        source,
        reason,
        path: stringValue(record?.path) ?? stringValue(record?.targetPath) ?? stringValue(record?.resourcePath),
        scopeKind: stringValue(record?.scopeKind),
        scope,
      });
      continue;
    }
    kept.push(scope);
  }
  return { kept, removed, changed: removed.length > 0 };
}

function invalidAcceptedPlanExecutionAccessScopeReason(scope: unknown): string | undefined {
  const record = objectRecord(scope);
  if (!record) return 'non_object_scope';
  const rawPath = stringValue(record.path) ?? stringValue(record.targetPath) ?? stringValue(record.resourcePath);
  const normalized = rawPath ? normalizePlanScope(rawPath).replace(/\/+$/, '') : '';
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return 'invalid_root_scope';
  if (normalized.startsWith('../') || normalized.includes('/../')) return 'path_traversal_scope';
  if (normalized.includes('*')) return 'wildcard_scope';
  if (isAbsolutePath(normalized)) return 'absolute_scope_not_allowed_in_execution_batch';
  return undefined;
}

function fileOperationFreshnessValidationReasons(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  resourcePackets: ResourcePacket[]
): string[] {
  const actionBundle = readActionBundle(proposal);
  const reasons: string[] = [];
  for (const [index, action] of (actionBundle?.actions ?? []).entries()) {
    const capability = actionEffectiveCapability(action as unknown as Record<string, unknown>);
    const actionKind = stringValue(action.kind) ?? (capability === 'fs.patch' ? 'patch' : undefined);
    const actionArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
    const targets = actionPlanTargetScopes(action, proposal)
      .map((target) => normalizeAcceptedPlanTargetScope(target, accepted))
      .filter(Boolean);
    if (capability === 'fs.patch' || ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) {
      const patchSpec = objectRecord(action.patchSpec) ?? objectRecord(actionArgs?.patchSpec);
      const match = objectRecord(patchSpec?.match);
      const matchText = stringValue(match?.text);
      if (!matchText) continue;
      if (!resourceEvidenceContainsExactBlock(resourcePackets, targets, matchText)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`patch action ${action.actionId || action.id || action.title || index} 缺少当前文件/search 证据：patchSpec.match.text 必须来自最近 ResourcePacket 的 fileText/searchResults（target=${targetLabel}）。请先返回 resourceRequest kind="search" 或读取目标文件/range。`);
      }
      continue;
    }
    if (capability === 'fs.write') {
      if (writeActionIsExplicitCreate(action, proposal)) continue;
      const targetIsAccepted = targets.some((target) => scopeCoveredByAcceptedPlanForCapability(target, capability, accepted));
      if (!targetIsAccepted && !resourceEvidenceMentionsAnyTarget(resourcePackets, targets) && !actionDeclaresOverwritePlan(action)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`write action ${action.actionId || action.id || action.title || index} 覆盖已有文件前缺少当前 read/search 证据或明确 overwrite plan（target=${targetLabel}）。请先返回 resourceRequest 读取目标文件/range/search。`);
      }
      continue;
    }
    if (capability === 'fs.delete') {
      if (!targets.some((target) => scopeCoveredByAcceptedPlanForCapability(target, capability, accepted)) && !resourceEvidenceMentionsAnyTarget(resourcePackets, targets)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`delete action ${action.actionId || action.id || action.title || index} 缺少当前目录/read/search 证据或已确认文件级范围（target=${targetLabel}）。请先返回 resourceRequest 读取目录树或目标文件证据。`);
      }
      continue;
    }
    if (capability === 'fs.rename' || actionKind === 'rename') {
      if (!resourceEvidenceMentionsAnyTarget(resourcePackets, targets)) {
        const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
        reasons.push(`rename action ${action.actionId || action.id || action.title || index} 缺少 source 当前证据（target=${targetLabel}）。请先返回 resourceRequest 读取 source 文件或目录证据。`);
      }
    }
  }
  return reasons;
}

function writeActionIsExplicitCreate(action: ActionBundleDraft['actions'][number], proposal: ProposalEnvelope): boolean {
  const actionKind = stringValue(action.kind);
  if (actionKind === 'create') return true;
  const actionArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  const payload = objectRecord(proposal.payload) ?? {};
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  const blockIds = new Set([
    stringValue(action.sourceBlockId),
    stringValue(action.replacementBlockId),
    stringValue(actionArgs?.sourceBlockId),
    stringValue(actionArgs?.replacementBlockId),
  ].filter((item): item is string => Boolean(item)));
  return codeBlocks.some((block) => {
    const record = objectRecord(block);
    const blockId = stringValue(record?.id) ?? stringValue(record?.blockId);
    if (!blockId || !blockIds.has(blockId)) return false;
    const operation = stringValue(record?.operation);
    return operation === 'create' || operation === 'createEmpty';
  });
}

function actionDeclaresOverwritePlan(action: ActionBundleDraft['actions'][number]): boolean {
  const toolArgs = objectRecord(action.toolArgs) ?? objectRecord(action.args);
  return toolArgs?.overwrite === true || toolArgs?.overwritePlan === true || toolArgs?.confirmedOverwrite === true;
}

function resourceEvidenceMentionsAnyTarget(packets: ResourcePacket[], targets: string[]): boolean {
  if (!packets.length || !targets.length) return false;
  const normalizedTargets = targets.map(normalizePlanScope).filter(Boolean);
  return packets.flatMap((packet) => packet.items ?? [])
    .filter((item) => item.status === 'resolved' || item.status === 'provided')
    .some((item) => resourcePacketItemMatchesAnyTarget(item, normalizedTargets));
}

function acceptedPlanReadOnlyResourceCompletion(
  accepted: AcceptedImplementationPlanContext,
  cursor: TaskExecutionCursor | undefined,
  current: CurrentTaskContext | undefined,
  packet: ResourcePacket
): { ok: true } & AcceptedPlanReadOnlyResourceCompletion | { ok: false } {
  if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return { ok: false };
  const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
  if (!task || accepted.completedTaskIds.includes(task.taskId)) return { ok: false };
  const capabilities = current.capabilities.length
    ? current.capabilities
    : task.capability
      ? [task.capability]
      : [];
  if (!capabilities.length || !capabilities.every(acceptedPlanCapabilityIsReadOnlyValidation)) return { ok: false };
  const targets = current.targets.length ? current.targets : task.targets;
  const coveredTargets = acceptedPlanResourceCoveredTargets(packet, targets);
  if (!targets.length || coveredTargets.length < uniqueStrings(targets.map(normalizePlanScope).filter(Boolean)).length) {
    return { ok: false };
  }
  const completedTaskIds = [...new Set([...accepted.completedTaskIds, task.taskId])];
  const completed = new Set(completedTaskIds);
  return {
    ok: true,
    taskId: task.taskId,
    newlyCompletedTaskIds: [task.taskId],
    completedTaskIds,
    remainingTaskIds: accepted.tasks.map((item) => item.taskId).filter((taskId) => !completed.has(taskId)),
    coveredTargets,
  };
}

function acceptedPlanCapabilityIsReadOnlyValidation(capability: string): boolean {
  return [
    'fs.read',
    'fs.list',
    'code.search',
    'git.read',
  ].includes(capability);
}

function acceptedPlanResourceCoveredTargets(packet: ResourcePacket, targets: string[]): string[] {
  const normalizedTargets = uniqueStrings(targets.map(normalizePlanScope).filter(Boolean));
  if (!normalizedTargets.length) return [];
  const resolvedItems = (packet.items ?? [])
    .filter((item) => item.status === 'resolved' || item.status === 'provided');
  return normalizedTargets.filter((target) =>
    resolvedItems.some((item) => resourcePacketItemMatchesTargetScope(item, target))
  );
}

function resourcePacketItemMatchesTargetScope(item: ResourcePacketItem, target: string): boolean {
  const normalizedTarget = normalizePlanScope(target);
  if (!normalizedTarget) return false;
  const candidates = [
    item.path,
    item.absolutePath,
    item.manifestEntryId,
  ]
    .map((value) => typeof value === 'string' ? normalizePlanScope(value) : '')
    .filter(Boolean);
  return candidates.some((candidate) =>
    candidate === normalizedTarget ||
    candidate.endsWith(`/${normalizedTarget}`) ||
    normalizedTarget.endsWith(`/${candidate}`) ||
    planScopeCovers(normalizedTarget, candidate) ||
    planScopeCovers(candidate, normalizedTarget)
  );
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
    return undefined;
  }
  if (isAbsolutePath(normalized)) {
    return undefined;
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
  const actionCapabilities = new Set(actions
    .map((action) => actionEffectiveCapability(action as unknown as Record<string, unknown>))
    .filter((item): item is string => Boolean(item)));
  const targetPaths = [...new Set(acceptedPlanProposalTargetScopes(proposal, accepted)
    .map((target) => target.normalized)
    .filter((target) => target && target !== '.' && target !== '..'))];
  const workUnitIds = workUnitIdsFromKernelEvents(kernelEvents);
  const priorCompleted = new Set(accepted.completedTaskIds);
  const coveredTaskIds = new Set<string>();
  for (const task of accepted.tasks) {
    if (!priorCompleted.has(task.taskId) && acceptedPlanTaskCoveredByBatch(task, targetPaths, actionCapabilities)) {
      coveredTaskIds.add(task.taskId);
    }
  }
  const newlyCompleted = new Set<string>();
  for (const task of accepted.tasks) {
    if (priorCompleted.has(task.taskId)) continue;
    if (!coveredTaskIds.has(task.taskId)) break;
    newlyCompleted.add(task.taskId);
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
  if (task.capability && actionCapabilities.size && !acceptedPlanCapabilitySetAllows(actionCapabilities, task.capability, 'actionCoversAccepted')) return false;
  if (!task.targets.length) return !task.capability || acceptedPlanCapabilitySetAllows(actionCapabilities, task.capability, 'actionCoversAccepted');
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

function acceptedPlanWithLatestCheckpoint(
  accepted: AcceptedImplementationPlanContext,
  events: AgentEvent[]
): AcceptedImplementationPlanContext {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'workflow_stage') continue;
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    if (stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
    if (stringValue(payload.runId) !== accepted.runId || stringValue(payload.planId) !== accepted.planId) continue;
    const completedTaskIds = stringArrayValue(payload.completedTaskIds);
    if (!completedTaskIds.length) return accepted;
    return acceptedPlanAfterBatch(accepted, completedTaskIds);
  }
  return accepted;
}

function acceptedPlanWithScopeDecisionEffect(
  accepted: AcceptedImplementationPlanContext,
  effect: RequirementOptionEffect | undefined
): AcceptedImplementationPlanContext {
  if (!effect || effect.kind !== 'expandCurrentTaskScope') return accepted;
  const currentTask = accepted.tasks.find((task) => task.taskId === effect.taskId)
    ?? accepted.tasks[Math.max(0, accepted.batchIndex - 1)];
  const capability = currentTask?.capability
    ?? accepted.capabilities.find(planAcceptedAutoGrantCapability);
  if (!capability) return accepted;
  const rawTarget = stringValue(effect.targetPath);
  if (!rawTarget) return accepted;
  const targetResourceKind = effect.targetResourceKind ?? (rawTarget.endsWith('/') ? 'directory' : 'file');
  const normalized = normalizePlanTargetForExecutionRoot(rawTarget, accepted.executionRoot);
  const targetPath = targetResourceKind === 'directory'
    ? concreteDirectoryOperationTarget(normalized)
    : concreteFileOperationTarget(normalized);
  if (!targetPath) return accepted;
  const operation = operationForCapability(capability);
  const sourceTaskId = effect.taskId ?? currentTask?.taskId;
  const grant: AcceptedPlanExactOperationGrant = {
    operation,
    targetPath,
    targetResourceKind,
    recursive: effect.recursive === true || targetResourceKind === 'directory',
    capability,
    sourceTaskId,
    source: 'implementationPlan',
  };
  const tasks = accepted.tasks.map((task) => {
    if (sourceTaskId && task.taskId !== sourceTaskId) return task;
    if (!sourceTaskId && task !== currentTask) return task;
    return {
      ...task,
      capability: task.capability ?? capability,
      targets: uniqueStrings([...task.targets, targetPath]),
    };
  });
  return {
    ...accepted,
    tasks,
    capabilities: uniqueStrings([...accepted.capabilities, capability]),
    targetScopes: uniqueStrings([...accepted.targetScopes, targetPath]),
    exactOperationGrants: normalizeAcceptedPlanExactOperationGrants([
      ...accepted.exactOperationGrants,
      grant,
    ], accepted.executionRoot),
  };
}

function operationForCapability(capability: string): string {
  if (capability === 'fs.delete') return 'delete';
  if (capability === 'fs.rename') return 'rename';
  if (capability === 'fs.patch') return 'patch';
  if (capability === 'fs.write') return 'write';
  return capability;
}

function acceptedPlanScopeDecisionResumeGuidance(effect: RequirementOptionEffect | undefined): string {
  if (effect?.kind === 'expandCurrentTaskScope') {
    const target = effect.targetPath ? ` target=${effect.targetPath}` : '';
    const kind = effect.targetResourceKind ? ` targetKind=${effect.targetResourceKind}` : '';
    const recursive = effect.recursive === true ? ' recursive=true' : '';
    return `The user confirmed an execution-scope expansion for the current accepted task. Continue the same task and output the next actionBundle or a necessary resourceRequest from the expanded overlay. Do not generate a new implementationPlan.${target}${kind}${recursive}`;
  }
  if (effect?.kind === 'confirmOperationGrant') {
    return 'The user confirmed an operation grant for the current accepted task. Continue the same task and output an actionBundle when evidence is sufficient. Do not generate a new implementationPlan.';
  }
  if (effect?.kind === 'continueCurrentTask') {
    return 'The user chose to continue the current accepted task. Keep the original accepted taskPlan and output the next actionBundle or necessary resourceRequest within the current task scope. Do not generate a new implementationPlan.';
  }
  return 'The user chose to regenerate a compliant batch. Keep the same current task, do not add targets or capabilities, and only remove or narrow content that is outside the current task scope.';
}

function looksLikeResourcePath(value: string): boolean {
  if (!value || value.includes(' ') || value.includes('\n')) return false;
  return value.includes('/') || /\.[A-Za-z0-9]+$/.test(value);
}

function looksLikeSearchEvidenceQuery(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || normalized.includes('\n')) return false;
  if (/\s/.test(normalized)) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$:.*#-]*$/.test(normalized);
}

function resourceEvidenceExistsForTarget(packets: ResourcePacket[], target: string): boolean {
  const normalized = normalizePlanScope(target);
  return packets.some((packet) =>
    packet.items.some((item) => {
      if (item.status !== 'resolved' && item.status !== 'provided') return false;
      return resourcePacketItemMatchesAnyTarget(item, [normalized]) && Boolean(resourcePacketItemEvidenceText(item));
    })
  );
}

function staticSyntaxReviewPacket(
  state: SessionDriverLoopRunState,
  accepted: AcceptedImplementationPlanContext,
  batch: Record<string, unknown>,
  events: unknown[]
): StaticSyntaxReviewPacket {
  const completed = completedWorkUnitFacts(events);
  const targetPaths = new Set<string>();
  for (const action of batchActionRecords(batch)) {
    const capability = actionEffectiveCapability(action);
    if (capability !== 'fs.write' && capability !== 'fs.patch') continue;
    const actionId = stringValue(action.actionId) ?? stringValue(action.id);
    if (actionId && completed.actionIds.size && !completed.actionIds.has(actionId)) continue;
    const target = actionFileTargetPath(action);
    if (target) targetPaths.add(normalizeAcceptedPlanTargetScope(target, accepted));
  }
  for (const block of recordArray(batch.codeBlocks)) {
    const target = stringValue(block.targetPath) ?? stringValue(block.path);
    if (target) targetPaths.add(normalizeAcceptedPlanTargetScope(target, accepted));
  }
  const files: StaticSyntaxReviewPacket['files'] = [];
  for (const target of targetPaths) {
    if (!isStaticSyntaxReviewTarget(target)) continue;
    const evidence = state.generatedArtifactEvidence.get(comparablePath(target));
    const content = evidence?.content ?? resourceTextForTarget(state.resourcePackets, target);
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

function staticSyntaxReviewMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  accepted: AcceptedImplementationPlanContext,
  packet: StaticSyntaxReviewPacket
): LlmChatRequest['messages'] {
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
        `Parent stable prefix hash: ${stableHash(prompt.stablePrefix).slice(0, 16)}; runId=${state.runId}; planId=${accepted.planId}.`,
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

function normalizeStaticSyntaxIssues(value: unknown): Array<Record<string, unknown>> {
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

function staticSyntaxReviewFactLines(kernelEvents: unknown[]): string[] {
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

function resourceTextForTarget(packets: ResourcePacket[], target: string): string | undefined {
  const normalized = normalizePlanScope(target);
  for (const packet of [...packets].reverse()) {
    for (const item of [...packet.items].reverse()) {
      if (item.status !== 'resolved' && item.status !== 'provided') continue;
      if (!resourcePacketItemMatchesAnyTarget(item, [normalized])) continue;
      const text = resourcePacketItemEvidenceText(item);
      if (text) return text;
    }
  }
  return undefined;
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

function relevantResourceEvidenceForTargets(
  packets: ResourcePacket[],
  targets: string[]
): string[] {
  const normalizedTargets = targets.map(normalizePlanScope).filter(Boolean);
  const items = packets.flatMap((packet) => packet.items ?? [])
    .filter((item) => item.status === 'resolved' || item.status === 'provided')
    .filter((item) => !normalizedTargets.length || resourcePacketItemMatchesAnyTarget(item, normalizedTargets));
  return items.slice(-6).map((item) => {
    const path = item.path ?? item.absolutePath ?? item.manifestEntryId;
    const kind = item.contentKind ?? 'resource';
    const body = resourcePacketItemEvidenceText(item);
    return [
      `ResourceEvidence kind=${kind}${path ? ` path=${path}` : ''}`,
      body ? clip(body, 2400) : item.contentSummary ?? 'no text evidence',
    ].join('\n');
  });
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
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

function normalizePlanTargetForExecutionRoot(
  value: string,
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): string {
  const normalized = normalizePlanScope(value);
  const rootRef = executionRoot?.ref;
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

function normalizeAcceptedPlanTargetScope(
  value: string,
  accepted: AcceptedImplementationPlanContext
): string {
  return normalizePlanTargetForExecutionRoot(value, accepted.executionRoot);
}

function acceptedPlanAutoExecutableCapability(capability: string): boolean {
  return [
    'fs.read',
    'fs.write',
    'fs.patch',
    'fs.delete',
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

function actionPlanTargetScopes(action: { resourceScope?: unknown; targetPath?: unknown; targetRef?: unknown; sourceBlockId?: unknown; replacementBlockId?: unknown; args?: unknown }, proposal: ProposalEnvelope): string[] {
  const args = objectRecord(action.args);
  const concreteTargets = stringArrayValue(action.targetPath);
  concreteTargets.push(...stringArrayValue(args?.path), ...stringArrayValue(args?.targetPath));
  const targetRefPath = fileTargetRefPath(action.targetRef);
  if (targetRefPath) concreteTargets.push(targetRefPath);
  const payload = objectRecord(proposal.payload) ?? {};
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  const blockIds = new Set([
    stringValue(action.sourceBlockId),
    stringValue(action.replacementBlockId),
    stringValue(args?.sourceBlockId),
    stringValue(args?.replacementBlockId),
  ].filter((item): item is string => Boolean(item)));
  for (const block of codeBlocks) {
    const record = objectRecord(block);
    const blockId = stringValue(record?.id) ?? stringValue(record?.blockId);
    if (!blockId || !blockIds.has(blockId)) continue;
    concreteTargets.push(...stringArrayValue(record?.path), ...stringArrayValue(record?.targetPath));
  }
  return concreteTargets.length ? concreteTargets : stringArrayValue(action.resourceScope);
}

function scopeCoveredByAcceptedPlan(scope: string, acceptedScopes: string[]): boolean {
  if (acceptedScopes.length === 0) return false;
  return acceptedScopes.some((accepted) => planScopeCovers(accepted, scope));
}

function scopeCoveredByAcceptedPlanForCapability(
  scope: string,
  capability: string | undefined,
  accepted: AcceptedImplementationPlanContext
): boolean {
  const normalized = normalizePlanScope(scope);
  if (!normalized) return false;
  if (exactOperationGrantCoversAcceptedPlanTarget(normalized, capability, accepted)) return true;
  if (capability === 'fs.delete' || capability === 'fs.rename') return false;
  const acceptedScopes = accepted.targetScopes
    .flatMap(expandPlanTargetTokens)
    .map(normalizePlanScope)
    .filter(Boolean);
  if (scopeCoveredByAcceptedPlan(normalized, acceptedScopes)) return true;
  return accepted.accessScopes.some((accessScope) => {
    if (accessScope.outsideWorkspace) return false;
    if (!accessScopeCapabilityMatches(accessScope, capability)) return false;
    return planScopeCovers(accessScope.path, normalized);
  });
}

function exactOperationGrantCoversAcceptedPlanTarget(
  scope: string,
  capability: string | undefined,
  accepted: AcceptedImplementationPlanContext
): boolean {
  const normalized = normalizePlanScopeIdentity(scope);
  if (!normalized || !capability) return false;
  return accepted.exactOperationGrants.some((grant) => {
    if (!exactOperationGrantCapabilityMatches(grant, capability)) return false;
    return normalizePlanScopeIdentity(grant.targetPath) === normalized;
  });
}

function exactOperationGrantCapabilityMatches(
  grant: AcceptedPlanExactOperationGrant,
  capability: string | undefined
): boolean {
  if (!capability) return false;
  if (grant.capability === capability) return true;
  if (grant.capability === 'fs.write' && capability === 'fs.patch') return true;
  if (capability === 'fs.write' && ['create', 'write'].includes(grant.operation)) return true;
  if (capability === 'fs.patch' && grant.operation === 'patch') return true;
  if (capability === 'fs.delete' && grant.operation === 'delete') return true;
  if (capability === 'fs.rename' && grant.operation === 'rename') return true;
  return false;
}

function acceptedPlanCapabilitySetAllows(
  allowed: Set<string>,
  capability: string,
  direction: 'acceptedCoversAction' | 'actionCoversAccepted' = 'acceptedCoversAction'
): boolean {
  if (allowed.has(capability)) return true;
  return [...allowed].some((item) =>
    direction === 'acceptedCoversAction'
      ? acceptedPlanCapabilityCovers(item, capability)
      : acceptedPlanCapabilityCovers(capability, item)
  );
}

function acceptedPlanCapabilityCovers(acceptedCapability: string, actionCapability: string): boolean {
  if (acceptedCapability === actionCapability) return true;
  if (acceptedCapability === 'fs.write' && actionCapability === 'fs.patch') return true;
  return false;
}

function accessScopeCapabilityMatches(scope: AcceptedPlanAccessScope, capability: string | undefined): boolean {
  if (!capability) return false;
  if (scope.capabilities.some((item) => acceptedPlanCapabilityCovers(item, capability))) return true;
  if (capability === 'fs.write' && scope.operations.some((operation) => operation === 'create' || operation === 'write')) return true;
  if (capability === 'fs.patch' && scope.operations.includes('patch')) return true;
  return false;
}

function planScopeCovers(accepted: string, candidate: string): boolean {
  if (!accepted || !candidate) return false;
  const acceptedNormalized = normalizePlanScopeIdentity(accepted);
  const candidateNormalized = normalizePlanScopeIdentity(candidate);
  if (acceptedNormalized === candidateNormalized) return true;
  if (isAbsolutePath(acceptedNormalized) || isAbsolutePath(candidateNormalized)) return false;
  const acceptedDir = acceptedNormalized.endsWith('/') ? acceptedNormalized : `${acceptedNormalized}/`;
  return candidateNormalized.startsWith(acceptedDir);
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizePlanScopeIdentity(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

// 任务编排修复：accepted taskPlan 的 task.targets 可能是自由文本（含路径与说明混排），
// 直接做 scope 匹配会因多路径合并串永不命中，造成合法写入被判越界、任务死结。
// 这里只做"语言无关的结构化路径提取"——按路径字符集取出 token，保留含 "/" 或带扩展名者；
// 不依赖任何自然语言分隔词/描述词、不针对特定样例或语言，黑盒通用。目录 token 仍由
// planScopeCovers 以前缀方式覆盖其下文件。
function expandPlanTargetTokens(target: string): string[] {
  if (!target || !target.trim()) return [];
  const candidates = target.match(/[A-Za-z0-9_.\-/]+/g) ?? [];
  const pathLike = candidates.filter((token) => token.includes('/') || /\.[A-Za-z0-9]+$/.test(token));
  return pathLike.length ? pathLike : [target.trim()];
}

function dirnameLike(value: string): string | undefined {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

function executionSliceRoleValue(value: unknown): ExecutionSliceRole | undefined {
  const role = stringValue(value);
  if (
    role === 'sourceCode' ||
    role === 'infra' ||
    role === 'script' ||
    role === 'test' ||
    role === 'docs' ||
    role === 'config' ||
    role === 'review'
  ) {
    return role;
  }
  return undefined;
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
      decisionScope: 'acceptedPlanBatchOutOfScope',
      acceptedPlanId: accepted?.planId,
      sourceProposalId: proposal.proposalId,
      parentRunId: state.runId,
      parentPhase: 'executing_accepted_plan',
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
            effect: { kind: 'continueCurrentTask' },
          },
          {
            id: 'revise-plan',
            label: 'Revise plan scope',
            description: 'Treat the new targets or capabilities as a plan revision before continuing.',
            effect: { kind: 'replan', reason: 'revise accepted plan scope' },
          },
        ]
        : [
          {
            id: 'regenerate-in-scope',
            label: '重新生成合规批次',
            description: '保持已确认计划不变，让 Agent 重新输出落在目标和能力范围内的下一批。',
            recommended: true,
            effect: { kind: 'continueCurrentTask' },
          },
          {
            id: 'revise-plan',
            label: '修订计划范围',
            description: '把新增目标或能力作为计划修订先确认，再继续执行。',
            effect: { kind: 'replan', reason: 'revise accepted plan scope' },
          },
        ],
      allowsFreeform: true,
      risks: reasons,
      affectedAreas: uniqueStrings([
        ...(accepted?.targetScopes ?? []),
        ...((accepted?.exactOperationGrants ?? []).map((grant) => grant.targetPath)),
      ]),
      constraints: [
        'Accepted taskPlan controls automatic batch execution scope.',
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
  const overlayPayload = interactionOverlayProjection(plan.interactionOverlay);
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
      permissionBundles: permissionBundlesFromReport(plan.planReviewReport),
      interventions: gateInterventionsFromReport(plan.planReviewReport),
      executionContract: objectRecord(plan.planReviewReport?.executionContract) ?? undefined,
      ...overlayPayload,
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
  status?: SessionRunStateStatus;
  reason: SessionRunStateReason;
  decisionOwner: DecisionOwnerRef;
  interactionOverlay?: InteractionOverlayContext;
  ts: string;
  id: string;
}): AgentEvent {
  const status = input.status ?? 'waiting';
  const overlayPayload = interactionOverlayProjection(input.interactionOverlay);
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
      ...overlayPayload,
      summary: sessionRunStateSummary(input.reason, status),
      channel: 'task',
      visibility: 'debug',
      presentation: 'stageSummary',
    },
  };
}

function sessionRunStateSummary(
  reason: SessionRunStateReason,
  status: SessionRunStateStatus
): string {
  if (status === 'cancelled') return '用户已忽略当前介入点，本轮会话已中止。';
  if (status === 'failed' && reason === 'work_unit_failed') return 'Kernel work unit 执行失败，本轮 accepted plan 自动推进已停止。';
  if (status === 'failed') return 'Session run failed.';
  if (status === 'completed' && reason === 'review') return 'Review 已通过，本次计划执行完成。';
  if (status === 'completed') return 'Session run is completed.';
  if (reason === 'accepted_plan_execution') return 'Session run is executing the accepted implementation plan.';
  if (status === 'running') return 'Session run is running.';
  if (reason === 'requirement') return 'Session run is waiting for requirement confirmation.';
  if (reason === 'permission') return 'Session run is waiting for a permission decision.';
  if (reason === 'review') return 'Session run is waiting for user review.';
  return 'Session run is waiting for plan review.';
}

// R2 requirement decision 驱动的任务推进事件：
// 复用 stage='accepted_plan.batch_checkpoint' 以便 acceptedPlanWithLatestCheckpoint 自动识别，
// 同时通过 source='requirementDecision' 字段保留审计来源（与正常批次完成区分）。
function requirementDrivenTaskCheckpointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  newlyCompletedTaskIds: string[],
  completedTaskIds: string[],
  remainingTaskIds: string[],
  effectKind: RequirementOptionEffect['kind'],
  selectedOptionId: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  const complete = remainingTaskIds.length === 0;
  const ledger = buildTaskLedgerSnapshot({
    planId: accepted.planId,
    runId,
    tasks: accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds,
    skippedTaskIds: effectKind === 'skipCurrentTask' ? newlyCompletedTaskIds : [],
    acceptedIncompleteTaskIds: effectKind === 'markAcceptedIncomplete' ? newlyCompletedTaskIds : [],
  });
  const summary = complete
    ? 'Accepted plan tasks resolved via user requirement decision; ready for final review.'
    : 'User requirement decision advanced the accepted plan task cursor.';
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      status: 'completed',
      summary,
      runId,
      planId: accepted.planId,
      source: 'requirementDecision',
      effectKind,
      selectedOptionId,
      batchIndex: accepted.batchIndex,
      newlyCompletedTaskIds,
      completedTaskIds,
      remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger.taskOrder,
      nextPendingTaskIds: ledger.pendingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
        status: 'completed',
        title: complete ? 'Accepted plan complete' : 'Task advanced by user decision',
        summary,
        source: 'session',
        runId,
        planId: accepted.planId,
      }),
    },
  };
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
  const ledger = buildTaskLedgerSnapshot({
    planId: accepted.planId,
    runId,
    tasks: accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds: progress.completedTaskIds,
    failedTaskId: failedOrBlocked
      ? accepted.tasks.find((task) => !progress.completedTaskIds.includes(task.taskId))?.taskId
      : undefined,
  });
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
      taskLedger: ledger,
      taskOrder: ledger.taskOrder,
      nextPendingTaskIds: ledger.pendingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : failedOrBlocked ? 'diagnostic' : 'editBatchQueued',
        status: failedOrBlocked ? 'blocked' : 'completed',
        title: complete ? 'Accepted plan complete' : failedOrBlocked ? 'Accepted plan batch blocked' : 'Accepted plan batch completed',
        summary,
        source: 'session',
        runId,
        planId: accepted.planId,
        targets: progress.targetPaths,
        actionIds: progress.actionIds,
        workUnitIds: progress.workUnitIds,
      }),
    },
  };
}

function acceptedPlanResourceValidationCheckpointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  packet: ResourcePacket,
  completion: AcceptedPlanReadOnlyResourceCompletion,
  ts: string,
  id: string
): AgentEvent {
  const complete = completion.remainingTaskIds.length === 0;
  const ledger = buildTaskLedgerSnapshot({
    planId: accepted.planId,
    runId,
    tasks: accepted.tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      targets: task.targets,
      capability: task.capability,
    })),
    completedTaskIds: completion.completedTaskIds,
  });
  const summary = complete
    ? 'Read-only evidence satisfied the remaining accepted task; ready for final review.'
    : 'Read-only evidence satisfied the current accepted task; Session will continue with the next task.';
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      status: 'completed',
      summary,
      runId,
      planId: accepted.planId,
      source: 'resourceValidation',
      batchIndex: accepted.batchIndex,
      resourcePacketId: packet.id,
      validatedTaskId: completion.taskId,
      coveredTargets: completion.coveredTargets,
      targetPaths: completion.coveredTargets,
      newlyCompletedTaskIds: completion.newlyCompletedTaskIds,
      completedTaskIds: completion.completedTaskIds,
      remainingTaskIds: completion.remainingTaskIds,
      taskLedger: ledger,
      taskOrder: ledger.taskOrder,
      nextPendingTaskIds: ledger.pendingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: complete ? 'reviewCheckpoint' : 'editBatchQueued',
        status: 'completed',
        title: complete ? 'Accepted plan validation complete' : 'Accepted plan read-only validation completed',
        summary,
        source: 'session',
        runId,
        planId: accepted.planId,
        targets: completion.coveredTargets,
      }),
    },
  };
}

function acceptedPlanActionBatchPreflightEvent(
  sessionId: string,
  plan: SessionPlanContext,
  batch: Record<string, unknown>,
  ts: string,
  id: string
): AgentEvent {
  const audit = acceptedPlanBatchPreflightAudit(batch);
  const summary = `Session 已完成已确认计划 actionBatch 提交前审计：${Array.isArray(audit.actions) ? audit.actions.length : 0} 个 action。`;
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.action_batch_preflight',
      status: 'completed',
      summary,
      runId: plan.runId,
      planId: plan.planId,
      audit,
      channel: 'progress',
      visibility: 'debug',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: 'diagnostic',
        status: 'completed',
        title: 'Accepted plan action batch preflight',
        summary,
        source: 'session',
        runId: plan.runId,
        planId: plan.planId,
      }),
    },
  };
}

function actionBundleAdmissionRepairingEvent(
  sessionId: string,
  runId: string,
  proposal: ProposalEnvelope,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent {
  const batch = proposalActionBundleAdmissionBatch(proposal);
  const audit = acceptedPlanBatchPreflightAudit(batch);
  const summary = `ActionBundle requires revision before entering the Plan card: ${reasons.join('; ')}`;
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'action_bundle_admission.repairing',
      status: 'running',
      summary,
      runId,
      proposalId: proposal.proposalId,
      reasons,
      audit,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      activity: conversationActivity({
        activityId: id,
        kind: 'diagnostic',
        status: 'running',
        title: 'ActionBundle admission repair',
        summary,
        source: 'session',
        runId,
        targets: audit.actions && Array.isArray(audit.actions)
          ? audit.actions.flatMap((item) => stringArrayValue(objectRecord(item)?.resourceScope).concat(stringValue(objectRecord(item)?.targetPath) ?? []))
          : [],
      }),
    },
  };
}

function actionBundleAdmissionFailureEvents(
  sessionId: string,
  runId: string,
  proposal: ProposalEnvelope,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `ActionBundle did not enter the Plan confirmation card; Session has stopped plan generation: ${reasons.join('; ')}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code: 'action_bundle_admission_failed',
        runId,
        proposalId: proposal.proposalId,
        reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'ActionBundle admission failed',
          summary,
          source: 'session',
          runId,
          errorCode: 'action_bundle_admission_failed',
          errorMessage: summary,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason: 'plan_review',
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId: proposal.proposalId,
        planId: proposal.proposalId,
      },
      ts,
      id: `${id}-state`,
    }),
  ];
}

function planActionBundlePreflightFailureEvents(
  sessionId: string,
  plan: SessionPlanContext,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `Accepted plan actionBatch pre-submission audit failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code: 'accepted_plan_action_batch_preflight_failed',
        runId: plan.runId,
        planId: plan.planId,
        reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan action batch preflight failed',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
          errorCode: 'accepted_plan_action_batch_preflight_failed',
          errorMessage: summary,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId: plan.runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId: plan.runId,
        targetId: plan.planId,
        planId: plan.planId,
      },
      interactionOverlay: plan.interactionOverlay,
      ts,
      id: `${id}-state`,
    }),
  ];
}

function planActionBundleExecutionExceptionEvents(
  sessionId: string,
  plan: SessionPlanContext,
  message: string,
  code: string,
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `已确认计划执行链路失败，Session 已停止自动推进：${message}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code,
        runId: plan.runId,
        planId: plan.planId,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan execution failed',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
          errorCode: code,
          errorMessage: message,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId: plan.runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId: plan.runId,
        targetId: plan.planId,
        planId: plan.planId,
      },
      interactionOverlay: plan.interactionOverlay,
      ts,
      id: `${id}-state`,
    }),
  ];
}

function planActionBundleExecutionFailureEvents(
  sessionId: string,
  plan: SessionPlanContext,
  kernelEvents: unknown[],
  batch: Record<string, unknown>,
  ts: string,
  id: string
): AgentEvent[] {
  const failures = actionBatchFailureDetails(kernelEvents, batch);
  const summary = failures.length
    ? `Accepted plan execution batch failed; Session has stopped auto-advancing: ${failures.map(failureDetailSummary).join('; ')}`
    : 'Accepted plan execution batch failed or blocked; Session has stopped auto-advancing.';
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_failed',
        status: 'failed',
        summary,
        runId: plan.runId,
        planId: plan.planId,
        failures,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch failed',
          summary,
          source: 'session',
          runId: plan.runId,
          planId: plan.planId,
          targets: failures.flatMap((failure) => failure.writeSet),
          actionIds: failures.flatMap((failure) => failure.actionId ? [failure.actionId] : []),
          workUnitIds: failures.flatMap((failure) => failure.workUnitId ? [failure.workUnitId] : []),
          errorCode: failures.find((failure) => failure.code)?.code,
          errorMessage: failures.find((failure) => failure.message)?.message,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId: plan.runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId: plan.runId,
        targetId: plan.planId,
        planId: plan.planId,
      },
      interactionOverlay: plan.interactionOverlay,
      ts,
      id: `${id}-state`,
    }),
  ];
}

function acceptedPlanNormalizationFailureEvents(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  reasons: string[],
  ts: string,
  id: string
): AgentEvent[] {
  const summary = `Accepted plan actionBatch pre-submission canonicalization failed; Session did not submit to Kernel: ${reasons.join('; ')}`;
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: summary,
        code: 'accepted_plan_batch_normalization_failed',
        runId,
        planId: accepted.planId,
        reasons,
        channel: 'error',
        visibility: 'conversation',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch normalization failed',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
          errorCode: 'accepted_plan_batch_normalization_failed',
          errorMessage: summary,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId: accepted.planId,
        planId: accepted.planId,
      },
      ts,
      id: `${id}-state`,
    }),
  ];
}

function acceptedPlanExecutionFailureEvents(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  kernelEvents: unknown[],
  batch: Record<string, unknown> | undefined,
  ts: string,
  id: string
): AgentEvent[] {
  const failures = actionBatchFailureDetails(kernelEvents, batch);
  const summary = failures.length
    ? `Accepted plan execution batch failed; Session has stopped auto-advancing: ${failures.map(failureDetailSummary).join('; ')}`
    : 'Accepted plan execution batch failed or blocked; Session has stopped auto-advancing.';
  return [
    {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: 'accepted_plan.batch_failed',
        status: 'failed',
        summary,
        runId,
        planId: accepted.planId,
        batchIndex: accepted.batchIndex,
        failures,
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity: conversationActivity({
          activityId: id,
          kind: 'diagnostic',
          status: 'failed',
          title: 'Accepted plan batch failed',
          summary,
          source: 'session',
          runId,
          planId: accepted.planId,
          targets: failures.flatMap((failure) => failure.writeSet),
          actionIds: failures.flatMap((failure) => failure.actionId ? [failure.actionId] : []),
          workUnitIds: failures.flatMap((failure) => failure.workUnitId ? [failure.workUnitId] : []),
          errorCode: failures.find((failure) => failure.code)?.code,
          errorMessage: failures.find((failure) => failure.message)?.message,
        }),
      },
    },
    sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'failed',
      status: 'failed',
      reason: 'work_unit_failed',
      decisionOwner: {
        kind: 'plan',
        runId,
        targetId: accepted.planId,
        planId: accepted.planId,
      },
      ts,
      id: `${id}-state`,
    }),
  ];
}

interface ActionBatchFailureDetail {
  status: 'failed' | 'blocked';
  workUnitId?: string;
  actionId?: string;
  message?: string;
  code?: string;
  kernelCode?: string;
  classification?: string;
  writeSet: string[];
}

function actionBatchFailureDetails(
  kernelEvents: unknown[],
  batch?: Record<string, unknown>
): ActionBatchFailureDetail[] {
  const workUnits = new Map<string, { actionId?: string; writeSet: string[] }>();
  const actionIndex = actionBatchActionIndex(batch);
  const details: ActionBatchFailureDetail[] = [];
  for (const event of kernelEvents) {
    const record = objectRecord(event);
    if (!record) continue;
    if (record.kind === 'work_unit.queued' || record.kind === 'work_unit.started') {
      const workUnit = objectRecord(record.workUnit);
      const id = stringValue(workUnit?.id) ?? stringValue(record.workUnitId);
      if (!id) continue;
      const prior = workUnits.get(id);
      workUnits.set(id, {
        actionId: stringValue(workUnit?.actionId) ?? stringValue(record.actionId) ?? prior?.actionId,
        writeSet: stringArrayValue(workUnit?.writeSet).length ? stringArrayValue(workUnit?.writeSet) : prior?.writeSet ?? [],
      });
      continue;
    }
    if (record.kind !== 'work_unit.failed' && record.kind !== 'work_unit.blocked') continue;
    const status = record.kind === 'work_unit.failed' ? 'failed' : 'blocked';
    const workUnitId = stringValue(record.workUnitId) ?? stringValue(objectRecord(record.workUnit)?.id);
    const indexed = workUnitId ? workUnits.get(workUnitId) : undefined;
    const error = objectRecord(record.error);
    const message = stringValue(record.message) ?? stringValue(error?.message) ?? stringValue(record.reason);
    const actionId = stringValue(record.actionId) ?? indexed?.actionId;
    const writeSet = stringArrayValue(record.writeSet).length ? stringArrayValue(record.writeSet) : indexed?.writeSet ?? [];
    const action = (actionId ? actionIndex.get(actionId) : undefined)
      ?? actionBatchDeleteActionForWriteSet(actionIndex, writeSet);
    const kernelCode = stringValue(record.code) ?? stringValue(error?.code);
    const classification = actionBatchFailureClassification(action, message);
    details.push({
      status,
      workUnitId,
      actionId,
      message,
      code: classification ?? kernelCode,
      kernelCode,
      classification,
      writeSet,
    });
  }
  return details;
}

function actionBatchActionIndex(batch?: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const action of batchActionRecords(batch)) {
    for (const id of [stringValue(action.actionId), stringValue(action.id)]) {
      if (id) index.set(id, action);
    }
  }
  return index;
}

function actionBatchDeleteActionForWriteSet(
  actionIndex: Map<string, Record<string, unknown>>,
  writeSet: string[]
): Record<string, unknown> | undefined {
  const targets = new Set(writeSet.map(normalizePlanScope).filter(Boolean));
  if (!targets.size) return undefined;
  for (const action of actionIndex.values()) {
    if (actionEffectiveCapability(action) !== 'fs.delete') continue;
    const actionTargets = actionTargetCandidates(action).map(normalizePlanScope).filter(Boolean);
    if (actionTargets.some((target) => targets.has(target))) return action;
  }
  return undefined;
}

function actionBatchFailureClassification(
  action: Record<string, unknown> | undefined,
  message: string | undefined
): string | undefined {
  if (!action) return undefined;
  const capability = actionEffectiveCapability(action);
  const normalizedMessage = (message ?? '').toLowerCase();
  if (capability === 'fs.patch' && normalizedMessage.includes('patch match did not occur')) {
    return 'patch_stale_or_mismatched_evidence';
  }
  if (capability !== 'fs.delete') return undefined;
  if (!message?.includes('fs.write target path is empty')) return undefined;
  return 'kernel_delete_compile_mismatch';
}

function failureDetailSummary(detail: ActionBatchFailureDetail): string {
  const parts = [
    detail.workUnitId ? `workUnit=${detail.workUnitId}` : undefined,
    detail.actionId ? `action=${detail.actionId}` : undefined,
    detail.code ? `code=${detail.code}` : undefined,
    detail.kernelCode && detail.kernelCode !== detail.code ? `kernelCode=${detail.kernelCode}` : undefined,
    detail.message,
    detail.writeSet.length ? `writeSet=${detail.writeSet.join(',')}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return parts.length ? parts.join(' ') : detail.status;
}

function temporaryGrantsForPlan(plan: SessionPlanContext): Record<string, unknown>[] {
  const report = plan.planReviewReport ?? {};
  const bundles = permissionBundlesFromReport(report);
  const gaps = Array.isArray(report.permissionGaps)
    ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const gapSet = new Set(gaps);
  const fileOperations = requiredFileOperationsFromReport(report);
  const accessScopes = requiredAccessScopesFromReport(report);
  const grants: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const operation of fileOperations) {
    const capability = operation.capability;
    if (!gapSet.has(capability)) continue;
    if (!planAcceptedAutoGrantCapability(capability)) continue;
    const targetPath = operation.targetResourceKind === 'directory'
      ? concreteDirectoryOperationTarget(operation.targetPath ?? operation.targetRefPath ?? '')
      : concreteFileOperationTarget(operation.targetPath ?? operation.targetRefPath ?? '');
    if (!targetPath) continue;
    const resourceKind = operation.targetResourceKind === 'directory'
      ? (operation.outsideWorkspace || isAbsolutePath(targetPath) ? 'externalDirectory' : 'workspaceDirectory')
      : (operation.outsideWorkspace || isAbsolutePath(targetPath) ? 'externalFile' : undefined);
    const key = `${capability}\0${resourceKind ?? 'default'}\0${targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push(temporaryGrant(plan, capability, targetPath, resourceKind));
  }
  for (const scope of accessScopes) {
    for (const capability of scope.capabilities) {
      if (!gapSet.has(capability)) continue;
      if (!planAcceptedAutoGrantCapability(capability)) continue;
      if (!accessScopeCapabilityAllowed(capability)) continue;
      const targetPath = normalizeAccessScopePath(scope.path);
      if (!targetPath) continue;
      const key = `${capability}\0workspaceModule\0${targetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(temporaryGrant(plan, capability, targetPath, scope.scopeKind === 'oneHopDependency' ? 'workspaceDependency' : 'workspaceModule'));
    }
  }
  for (const bundle of bundles) {
    if (!planAcceptedAutoGrantCapability(bundle.capability)) continue;
    if (['fs.write', 'fs.patch', 'fs.delete', 'fs.rename'].includes(bundle.capability) && !bundle.resourcePath) {
      continue;
    }
    const key = `${bundle.capability}\0${bundle.resourceKind}\0${bundle.resourcePath ?? 'bundle'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push(temporaryGrantForPermissionBundle(plan, bundle));
  }
  return grants;
}

function temporaryGrantForPermissionBundle(
  plan: SessionPlanContext,
  bundle: PermissionBundleProjection
): Record<string, unknown> {
  return {
    id: `grant-${safeSegment(plan.planId)}-${safeSegment(bundle.id)}`,
    capability: bundle.capability,
    resourceKind: bundle.resourceKind,
    resourcePath: bundle.resourcePath,
    reason: `Plan ${plan.planId} accepted by user; Kernel-derived permission bundle ${bundle.id} is scoped to this batch contract and expires after review or terminal work unit.`,
    permissionBundle: {
      source: 'kernelExecutionContract',
      planId: plan.planId,
      contractId: kernelExecutionContractId(plan.planReviewReport),
      bundleId: bundle.id,
      capability: bundle.capability,
      targets: bundle.targets,
      operationIds: bundle.operationIds,
      expiresAfter: bundle.expiresAfter,
    },
  };
}

interface RequiredFileOperationProjection {
  operation: string;
  targetPath: string;
  targetRefPath?: string;
  capability: string;
  actionId?: string;
  targetKind?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  outsideWorkspace?: boolean;
}

function requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): RequiredFileOperationProjection[] {
  const operations = Array.isArray(report?.requiredFileOperations) ? report.requiredFileOperations : [];
  const output: RequiredFileOperationProjection[] = [];
  const seen = new Set<string>();
  for (const item of operations) {
    const record = objectRecord(item);
    if (!record) continue;
    const operation = stringValue(record.operation);
    const targetRefPath = fileTargetRefPath(record.targetRef);
    const rawTargetPath = stringValue(record.targetPath) ?? targetRefPath ?? '';
    const capability = stringValue(record.capability);
    const targetResourceKindValue = stringValue(record.targetResourceKind);
    const targetResourceKind = targetResourceKindValue === 'directory' || targetResourceKindValue === 'dir'
      ? 'directory'
      : 'file';
    const targetPath = targetResourceKind === 'directory'
      ? concreteDirectoryOperationTarget(rawTargetPath)
      : concreteFileOperationTarget(rawTargetPath);
    if (!operation || !targetPath || !capability) continue;
    const actionId = stringValue(record.actionId);
    const targetKind = stringValue(record.targetKind);
    const recursive = record.recursive === true;
    const outsideWorkspace = Boolean(record.outsideWorkspace) || isAbsolutePath(targetPath);
    const key = `${operation}\0${capability}\0${targetPath}\0${actionId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ operation, targetPath, targetRefPath, capability, actionId, targetKind, targetResourceKind, recursive, outsideWorkspace });
  }
  return output;
}

function exactOperationGrantsFromPlanReviewReport(
  report: Record<string, unknown> | undefined,
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): AcceptedPlanExactOperationGrant[] {
  return normalizeAcceptedPlanExactOperationGrants(
    requiredFileOperationsFromReport(report).map((operation) => ({
      ...operation,
      source: 'kernelPlanReview' as const,
    })),
    executionRoot
  );
}

function exactOperationGrantsFromImplementationPlan(
  plan: Record<string, unknown> | undefined,
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): AcceptedPlanExactOperationGrant[] {
  const grants: AcceptedPlanExactOperationGrant[] = [];
  const topLevelOperations = Array.isArray(plan?.fileOperations) ? plan.fileOperations : [];
  for (const operation of topLevelOperations) {
    const grant = exactOperationGrantFromRawOperation(operation, undefined, executionRoot);
    if (grant) grants.push(grant);
  }
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  for (const item of tasks) {
    const task = objectRecord(item);
    if (!task) continue;
    const sourceTaskId = stringValue(task.taskId) ?? stringValue(task.id);
    const taskCapability = stringValue(task.capability);
    const fileOperations = Array.isArray(task.fileOperations) ? task.fileOperations : [];
    for (const operation of fileOperations) {
      const grant = exactOperationGrantFromRawOperation(operation, {
        capability: taskCapability,
        sourceTaskId,
      }, executionRoot);
      if (grant) grants.push(grant);
    }
    if (taskCapability === 'fs.delete' || taskCapability === 'fs.rename') {
      for (const target of acceptedPlanTaskTargets(task)) {
        const grant = exactOperationGrantFromRawOperation({
          operation: taskCapability === 'fs.delete' ? 'delete' : 'rename',
          capability: taskCapability,
          targetPath: target,
        }, { capability: taskCapability, sourceTaskId }, executionRoot);
        if (grant) grants.push(grant);
      }
    }
  }
  return normalizeAcceptedPlanExactOperationGrants(grants, executionRoot);
}

function exactOperationGrantFromRawOperation(
  value: unknown,
  fallback: { capability?: string; sourceTaskId?: string } | undefined,
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): AcceptedPlanExactOperationGrant | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const operation = stringValue(record.operation);
  const capability = stringValue(record.capability) ?? fallback?.capability;
  const rawTarget = stringValue(record.targetPath) ?? fileTargetRefPath(record.targetRef);
  const targetResourceKind = fileOperationTargetResourceKind(record, rawTarget);
  const targetPath = rawTarget
    ? targetResourceKind === 'directory'
      ? concreteDirectoryOperationTarget(normalizePlanTargetForExecutionRoot(rawTarget, executionRoot))
      : concreteFileOperationTarget(normalizePlanTargetForExecutionRoot(rawTarget, executionRoot))
    : undefined;
  if (!operation || !capability || !targetPath) return undefined;
  if (!planAcceptedAutoGrantCapability(capability)) return undefined;
  return {
    operation,
    targetPath,
    targetRefPath: fileTargetRefPath(record.targetRef),
    targetResourceKind,
    recursive: fileOperationRecursive(record, targetResourceKind, rawTarget),
    capability,
    actionId: stringValue(record.actionId),
    sourceTaskId: fallback?.sourceTaskId ?? stringValue(record.sourceTaskId) ?? stringValue(record.taskId),
    outsideWorkspace: Boolean(record.outsideWorkspace) || isAbsolutePath(targetPath),
    source: 'implementationPlan',
  };
}

function normalizeAcceptedPlanExactOperationGrants(
  grants: AcceptedPlanExactOperationGrant[],
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): AcceptedPlanExactOperationGrant[] {
  const output: AcceptedPlanExactOperationGrant[] = [];
  const seen = new Set<string>();
  for (const grant of grants) {
    const targetPath = grant.targetResourceKind === 'directory'
      ? concreteDirectoryOperationTarget(normalizePlanTargetForExecutionRoot(grant.targetPath, executionRoot))
      : concreteFileOperationTarget(normalizePlanTargetForExecutionRoot(grant.targetPath, executionRoot));
    if (!grant.operation || !grant.capability || !targetPath) continue;
    if (!planAcceptedAutoGrantCapability(grant.capability)) continue;
    const key = `${grant.operation}\0${grant.capability}\0${targetPath}\0${grant.actionId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...grant,
      targetPath,
      targetResourceKind: grant.targetResourceKind ?? 'file',
      outsideWorkspace: Boolean(grant.outsideWorkspace) || isAbsolutePath(targetPath),
    });
  }
  return output;
}

function fileOperationTargetResourceKind(
  record: Record<string, unknown>,
  rawTarget: string | undefined
): 'file' | 'directory' {
  const value = stringValue(record.targetResourceKind) ?? stringValue(record.targetKind);
  if (value === 'directory' || value === 'dir') return 'directory';
  if (value === 'file') return 'file';
  return rawTarget?.trim().endsWith('/') ? 'directory' : 'file';
}

function fileOperationRecursive(
  record: Record<string, unknown>,
  targetResourceKind: 'file' | 'directory',
  rawTarget: string | undefined
): boolean {
  if (record.recursive === true) return true;
  return targetResourceKind === 'directory' && Boolean(rawTarget?.trim().endsWith('/'));
}

function requiredAccessScopesFromReport(report: Record<string, unknown> | undefined): AcceptedPlanAccessScope[] {
  const scopes = Array.isArray(report?.requiredAccessScopes) ? report.requiredAccessScopes : [];
  return normalizeAcceptedPlanAccessScopes(scopes, 'kernelPlanReview');
}

function accessScopesFromImplementationPlan(plan: Record<string, unknown> | undefined): AcceptedPlanAccessScope[] {
  const scopes: unknown[] = [];
  if (Array.isArray(plan?.accessScopes)) scopes.push(...plan.accessScopes);
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  for (const item of tasks) {
    const task = objectRecord(item);
    if (!task) continue;
    if (Array.isArray(task.accessScopes)) scopes.push(...task.accessScopes.map((scope) => ({
      ...(objectRecord(scope) ?? {}),
      sourceTaskId: stringValue((objectRecord(scope) ?? {})?.sourceTaskId) ?? stringValue(task.taskId) ?? stringValue(task.id),
      capability: stringValue((objectRecord(scope) ?? {})?.capability) ?? stringValue(task.capability),
    })));
  }
  return normalizeAcceptedPlanAccessScopes(scopes, 'implementationPlan');
}

function normalizeAcceptedPlanAccessScopes(
  scopes: unknown[],
  source: AcceptedPlanAccessScope['source']
): AcceptedPlanAccessScope[] {
  const output: AcceptedPlanAccessScope[] = [];
  const seen = new Set<string>();
  for (const item of scopes) {
    const record = objectRecord(item);
    if (!record) continue;
    const scopeKind = stringValue(record.scopeKind) ?? stringValue(record.kind) ?? 'workspaceModule';
    const rawPath = stringValue(record.path) ?? stringValue(record.targetPath);
    const path = rawPath ? normalizeAccessScopePath(rawPath) : undefined;
    if (!path) continue;
    const dependencyDepth = typeof record.dependencyDepth === 'number' ? record.dependencyDepth : (
      scopeKind === 'oneHopDependency' ? 1 : 0
    );
    if (dependencyDepth > 1) continue;
    const outsideWorkspace = Boolean(record.outsideWorkspace) || isAbsolutePath(path);
    if (outsideWorkspace) continue;
    const capabilities = stringArrayValue(record.capabilities)
      .concat(stringArrayValue(record.capability))
      .filter((capability) => accessScopeCapabilityAllowed(capability));
    const normalizedCapabilities = capabilities.length
      ? [...new Set(capabilities)]
      : ['fs.write', 'fs.patch'];
    const operations = stringArrayValue(record.operations).length
      ? stringArrayValue(record.operations)
      : accessScopeOperationsForCapabilities(normalizedCapabilities);
    const key = `${scopeKind}\0${path}\0${normalizedCapabilities.join(',')}\0${dependencyDepth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      scopeKind,
      path,
      capabilities: normalizedCapabilities,
      operations: [...new Set(operations)],
      reason: stringValue(record.reason),
      dependencyDepth,
      sourceTaskId: stringValue(record.sourceTaskId) ?? stringValue(record.taskId),
      outsideWorkspace: false,
      source,
    });
  }
  return output;
}

function normalizeAccessScopePath(value: string): string | undefined {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsolutePath(normalized)) return undefined;
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*')) return undefined;
  return normalized;
}

function accessScopeCapabilityAllowed(capability: string): boolean {
  return ['fs.write', 'fs.patch'].includes(capability);
}

function accessScopeOperationsForCapabilities(capabilities: string[]): string[] {
  const operations: string[] = [];
  if (capabilities.includes('fs.write')) operations.push('create', 'write');
  if (capabilities.includes('fs.patch')) operations.push('patch');
  return operations.length ? operations : ['write', 'patch'];
}

function concreteFileOperationTarget(value: string): string | undefined {
  const normalized = normalizePlanScope(value);
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsolutePath(normalized)) return concreteAbsoluteFileOperationTarget(normalized);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*')) return undefined;
  if (normalized.endsWith('/')) return undefined;
  return normalized;
}

function concreteDirectoryOperationTarget(value: string): string | undefined {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsolutePath(normalized)) return concreteAbsoluteDirectoryOperationTarget(normalized);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*')) return undefined;
  return normalized;
}

function concreteAbsoluteFileOperationTarget(value: string): string | undefined {
  const normalized = normalizeSlashes(value);
  if (!isAbsolutePath(normalized)) return undefined;
  if (!normalized || normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) return undefined;
  if (normalized.includes('*')) return undefined;
  if (normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
  if (normalized.endsWith('/')) return undefined;
  const base = basename(normalized);
  if (!base || base === '.' || base === '..') return undefined;
  return normalized;
}

function concreteAbsoluteDirectoryOperationTarget(value: string): string | undefined {
  const normalized = normalizeSlashes(value).replace(/\/+$/, '');
  if (!isAbsolutePath(normalized)) return undefined;
  if (!normalized || normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) return undefined;
  if (normalized.includes('*')) return undefined;
  if (normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
  const base = basename(normalized);
  if (!base || base === '.' || base === '..') return undefined;
  return normalized;
}

function acceptedPlanConcreteFileOperationTarget(
  value: string,
  accepted?: AcceptedImplementationPlanContext
): string | undefined {
  const normalized = accepted ? normalizeAcceptedPlanTargetScope(value, accepted) : normalizePlanScope(value);
  return concreteFileOperationTarget(normalized);
}

function acceptedPlanConcreteDeleteOperationTarget(
  value: string,
  accepted: AcceptedImplementationPlanContext | undefined,
  grant?: AcceptedPlanExactOperationGrant
): string | undefined {
  const normalized = accepted ? normalizeAcceptedPlanTargetScope(value, accepted) : normalizePlanScope(value);
  if (grant?.targetResourceKind === 'directory') {
    return concreteDirectoryOperationTarget(normalized);
  }
  return concreteFileOperationTarget(normalized) ?? concreteDirectoryOperationTarget(normalized);
}

function acceptedPlanExactOperationGrantForAction(
  action: Record<string, unknown>,
  accepted?: AcceptedImplementationPlanContext
): AcceptedPlanExactOperationGrant | undefined {
  if (!accepted) return undefined;
  const capability = actionEffectiveCapability(action);
  const rawTarget = actionFileTargetPath(action);
  if (!capability || !rawTarget) return undefined;
  const normalized = normalizeAcceptedPlanTargetScope(rawTarget, accepted).replace(/\/+$/, '');
  return accepted.exactOperationGrants.find((grant) =>
    exactOperationGrantCapabilityMatches(grant, capability) &&
    normalizePlanScope(grant.targetPath).replace(/\/+$/, '') === normalized
  );
}

function planAcceptedAutoGrantCapability(capability: string): boolean {
  return ['fs.write', 'fs.patch', 'fs.delete', 'fs.rename'].includes(capability);
}

function kernelExecutionContractId(report: Record<string, unknown> | undefined): string | undefined {
  const contract = objectRecord(report?.executionContract);
  return stringValue(contract?.id);
}

function temporaryGrant(
  plan: SessionPlanContext,
  capability: string,
  resourcePath?: string,
  resourceKind?: string
): Record<string, unknown> {
  return {
    id: `grant-${safeSegment(plan.planId)}-${safeSegment(capability)}-${resourcePath ? safeSegment(resourcePath) : 'run'}`,
    capability,
    resourceKind: resourceKind ?? resourceKindForCapability(capability),
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
  if (['fs.write', 'fs.patch', 'fs.delete', 'fs.rename'].includes(capability)) return 'workspaceFile';
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
  const facts = [
    ...reviewFactLines(kernelEvents),
    ...staticSyntaxReviewFactLines(kernelEvents),
  ];
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
  const language = visibleLanguageForRequest(plan.userPlan);
  const summary = reviewWaitingSummary(failed, blocked, language);
  const readableReview = buildReadableReviewSummary(kernelEvents, reviewFacts);
  const acceptedPlanForReview = plan.implementationPlan
    ? acceptedImplementationPlanContext(plan)
    : undefined;
  const reviewTaskLedger = acceptedPlanForReview
    ? buildAcceptedPlanTaskLedger(acceptedPlanAfterBatch(
      acceptedPlanForReview,
      acceptedPlanBatchProgress(acceptedPlanForReview, proposalEnvelopeFromPlanContext(plan), kernelEvents).completedTaskIds
    ))
    : undefined;
  const reviewFactsContext = buildReviewFactsContext({
    planId: plan.planId,
    runId: plan.runId,
    taskLedger: reviewTaskLedger,
    changedFileCount: readableReview.changedFiles.length,
    auditRefCount: readableReview.auditRefs.length,
  });
  return {
    id,
    sessionId,
    ts,
    kind: 'review_summary',
    payload: {
      title: 'Review',
      summary,
      messageKey: failed || blocked ? 'review.summary.needsAttention' : 'review.summary.waitingUserReview',
      messageArgs: {
        completed: String(completed),
        failed: String(failed),
        blocked: String(blocked),
        toolResults: String(toolResults),
      },
      content: waitingReviewContent(plan, readableReview, summary, completed, failed, blocked, toolResults, continuations, gitReview, reviewFacts, language),
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
      readableReview,
      reviewFactsContext,
      changedFiles: readableReview.changedFiles,
      developerDetails: {
        facts,
        reviewFacts,
        gitReview,
        reviewFactsContext,
      },
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
  readableReview: ReadableReviewSummary,
  summary: string,
  completed: number,
  failed: number,
  blocked: number,
  toolResults: number,
  continuations: unknown[],
  gitReview?: Record<string, unknown>,
  reviewFacts?: Record<string, unknown>,
  language: VisibleLanguage = 'zh-CN'
): string {
  const reviewLines = reviewExpectationLines(plan, language);
  const labels = reviewContentLabels(language);
  const gitLines = gitReviewSummaryLines(gitReview, language);
  const generatedLines = reviewGeneratedArtifactLines(reviewFacts, language);
  const normalizationLines = reviewPathNormalizationLines(reviewFacts, language);
  const changedFileLines = readableReviewChangedFileLines(readableReview, language);
  return [
    '## Review',
    '',
    summary,
    '',
    `### ${labels.executionResult}`,
    `- ${labels.workUnitsCompleted}：${completed}`,
    `- ${labels.workUnitsFailed}：${failed}`,
    `- ${labels.workUnitsBlocked}：${blocked}`,
    `- ${labels.toolFacts}：${toolResults}`,
    '',
    `### ${labels.changedFiles}`,
    changedFileLines.length ? changedFileLines.join('\n') : `- ${labels.noChangedFiles}`,
    '',
    `### ${labels.generatedArtifacts}`,
    generatedLines.length ? generatedLines.join('\n') : `- ${labels.noGeneratedArtifacts}`,
    '',
    `### ${labels.pathDiagnostics}`,
    normalizationLines.length ? normalizationLines.join('\n') : `- ${labels.noPathDiagnostics}`,
    '',
    `### ${labels.gitChanges}`,
    gitLines.length ? gitLines.join('\n') : `- ${labels.noGitChanges}`,
    '',
    `### ${labels.auditDetails}`,
    readableReview.developerDetailsAvailable
      ? `- ${labels.auditDetailsAvailable}`
      : `- ${labels.noAuditDetails}`,
    readableReview.auditRefs.length ? `- auditRefs：${readableReview.auditRefs.slice(0, 12).join(', ')}` : '- auditRefs：none',
    '',
    `### ${labels.originalPlan}`,
    clip(plan.userPlan, 1200),
    '',
    `### ${labels.validation}`,
    reviewLines.length ? reviewLines.join('\n') : `- ${labels.noValidation}`,
    '',
    `### ${labels.nextDecision}`,
    failed || blocked
      ? `- ${labels.failedDecisionHint}`
      : `- ${labels.successDecisionHint}`,
    continuations.length
      ? `- ${labels.continuationHint.replace('{count}', String(continuations.length))}`
      : `- ${labels.noContinuation}`,
  ].join('\n');
}

function reviewWaitingSummary(failed: number, blocked: number, language: VisibleLanguage): string {
  if (language === 'en-US') {
    return failed || blocked
      ? 'The current batch progressed but has failed or blocked items. Review the facts and decide whether to revise.'
      : 'The current batch has executed. Review the tool facts and validation results.';
  }
  return failed || blocked
    ? '当前批次已推进，但存在失败或阻塞项，请审查事实后决定是否修订。'
    : '当前批次已执行，请审查工具事实与验证结果。';
}

function reviewContentLabels(language: VisibleLanguage): Record<string, string> {
  if (language === 'en-US') {
    return {
      executionResult: 'Execution Result',
      workUnitsCompleted: 'WorkUnits completed',
      workUnitsFailed: 'WorkUnits failed',
      workUnitsBlocked: 'WorkUnits blocked',
      toolFacts: 'Tool facts',
      changedFiles: 'Files Changed In This Batch',
      noChangedFiles: 'No file-level change summary was recorded for this batch.',
      generatedArtifacts: 'Agent Generated Artifacts',
      noGeneratedArtifacts: 'ReviewFacts did not record agentGenerated artifacts.',
      pathDiagnostics: 'Path Normalization Diagnostics',
      noPathDiagnostics: 'No path prefix stripping or duplicate-root diagnostics were recorded.',
      gitChanges: 'Git Changes',
      noGitChanges: 'No Git change facts are available.',
      auditDetails: 'Audit Details',
      auditDetailsAvailable: 'Raw Kernel facts, tool facts, and ReviewFacts are retained in developerDetails / audit refs. The main view does not expand full JSON.',
      noAuditDetails: 'No developerDetails are available.',
      originalPlan: 'Original Plan Summary',
      validation: 'Validation And Startup Suggestions',
      noValidation: 'The current plan did not provide an executable validation command; add one in a later turn if needed.',
      nextDecision: 'Next Decision',
      failedDecisionHint: 'Empty input accepts and closes the current batch without retrying failed items; type Review feedback to re-enter planning.',
      successDecisionHint: 'Empty input accepts and closes the current batch; typed text is treated as Review revision feedback and re-enters planning.',
      continuationHint: 'The current plan recorded {count} continuation intent(s). Review acceptance follows agent.reviewContinuationMode. Auto mode generates the next Plan only; the new Plan still requires confirmation.',
      noContinuation: 'The current plan did not record continuation batches.',
    };
  }
  return {
    executionResult: '执行结果',
    workUnitsCompleted: 'WorkUnit 完成',
    workUnitsFailed: 'WorkUnit 失败',
    workUnitsBlocked: 'WorkUnit 阻塞',
    toolFacts: 'Tool facts',
    changedFiles: '本轮实际改动文件',
    noChangedFiles: '当前批次没有记录文件级变更摘要。',
    generatedArtifacts: '本轮 Agent 生成产物',
    noGeneratedArtifacts: '当前 ReviewFacts 没有记录 agentGenerated 产物。',
    pathDiagnostics: '路径归一化诊断',
    noPathDiagnostics: '当前没有路径前缀剥离或重复根路径诊断。',
    gitChanges: 'Git 变更',
    noGitChanges: '当前没有可展示的 Git 变更事实。',
    auditDetails: '审计详情',
    auditDetailsAvailable: '原始 Kernel facts、tool facts 与 ReviewFacts 已保留在 developerDetails / audit refs 中，主视图不展开完整 JSON。',
    noAuditDetails: '当前没有可展开的 developerDetails。',
    originalPlan: '原计划摘要',
    validation: '验证与启动建议',
    noValidation: '当前计划未提供可执行验证命令，需要下一轮补充。',
    nextDecision: '后续决策',
    failedDecisionHint: '空输入通过并结束当前批次，不会自动执行失败项；如需修复，请在输入框输入 Review 修改意见，系统会重新进入 Plan。',
    successDecisionHint: '空输入通过并结束当前批次；输入文字会作为 Review 修订意见，系统会重新进入 Plan。',
    continuationHint: '当前计划登记了 {count} 个后续意图；Review 通过后会按 agent.reviewContinuationMode 处理。自动模式会生成下一批 Plan；新 Plan 仍需确认，确认后的合规 actionBundle 会自动提交 Kernel 执行。',
    noContinuation: '当前计划没有登记后续批次。',
  };
}

function buildReadableReviewSummary(
  kernelEvents: unknown[],
  reviewFacts?: Record<string, unknown>
): ReadableReviewSummary {
  const changedFiles = new Map<string, ReadableReviewChangedFile>();
  const auditRefs: string[] = [];
  const generatedArtifacts = Array.isArray(reviewFacts?.generatedArtifacts) ? reviewFacts.generatedArtifacts : [];
  for (const item of generatedArtifacts) {
    const record = objectRecord(item);
    if (!record) continue;
    const path = reviewDisplayPath(record);
    if (!path) continue;
    const operation = reviewOperation(record);
    const actionId = stringValue(record.actionId);
    const key = `${path}:${operation}:${actionId ?? ''}`;
    changedFiles.set(key, {
      path,
      operation,
      status: 'completed',
      actionId,
      summary: `${path} operation=${operation}`,
      messageKey: 'review.changedFile',
      messageArgs: { path, operation, status: 'completed' },
      auditRef: actionId,
    });
    if (actionId) auditRefs.push(actionId);
  }

  const completedWorkUnits = Array.isArray(reviewFacts?.completedWorkUnits) ? reviewFacts.completedWorkUnits : [];
  const failedWorkUnits = Array.isArray(reviewFacts?.failedWorkUnits) ? reviewFacts.failedWorkUnits : [];
  const blockedWorkUnits = Array.isArray(reviewFacts?.blockedWorkUnits) ? reviewFacts.blockedWorkUnits : [];
  for (const item of completedWorkUnits) addReviewWorkUnitFile(changedFiles, auditRefs, item, 'completed');
  for (const item of failedWorkUnits) addReviewWorkUnitFile(changedFiles, auditRefs, item, 'failed');
  for (const item of blockedWorkUnits) addReviewWorkUnitFile(changedFiles, auditRefs, item, 'blocked');

  const toolResults = Array.isArray(reviewFacts?.toolResults) ? reviewFacts.toolResults : [];
  for (const item of toolResults) addReviewToolFile(changedFiles, auditRefs, item);

  if (!changedFiles.size) {
    for (const event of kernelEvents) {
      const record = objectRecord(event);
      if (!record) continue;
      const kind = stringValue(record.kind);
      if (kind === 'work_unit.completed') addReviewWorkUnitFile(changedFiles, auditRefs, record, 'completed');
      if (kind === 'work_unit.failed') addReviewWorkUnitFile(changedFiles, auditRefs, record, 'failed');
      if (kind === 'work_unit.blocked') addReviewWorkUnitFile(changedFiles, auditRefs, record, 'blocked');
      if (kind === 'tool.completed') addReviewToolFile(changedFiles, auditRefs, record);
    }
  }

  const files = [...changedFiles.values()];
  const operationCounts: Record<string, number> = {};
  for (const file of files) operationCounts[file.operation] = (operationCounts[file.operation] ?? 0) + 1;
  return {
    schemaVersion: 'deepcode.session.readable-review.v1',
    changedFiles: files,
    operationCounts,
    auditRefs: [...new Set(auditRefs.filter((item) => item.trim().length > 0))],
    developerDetailsAvailable: Boolean(reviewFacts) || kernelEvents.length > 0,
    messageKey: 'review.summary',
    messageArgs: {
      changedFiles: String(files.length),
      auditRefs: String(auditRefs.length),
    },
  };
}

function addReviewWorkUnitFile(
  changedFiles: Map<string, ReadableReviewChangedFile>,
  auditRefs: string[],
  value: unknown,
  status: ReadableReviewChangedFile['status']
): void {
  const record = objectRecord(value);
  if (!record) return;
  const output = objectRecord(record.output);
  const path = reviewDisplayPath(output) ?? reviewDisplayPath(record);
  if (!path) return;
  const actionId = stringValue(output?.actionId) ?? stringValue(record.actionId);
  const workUnitId = stringValue(record.workUnitId);
  const operation = reviewOperation(output ?? record);
  const failure = status === 'failed' || status === 'blocked'
    ? reviewFailureDetail(record, output)
    : {};
  const key = `${path}:${operation}:${workUnitId ?? actionId ?? status}`;
  changedFiles.set(key, {
    path,
    operation,
    status,
    actionId,
    workUnitId,
    failureClassification: failure.classification,
    failureReason: failure.reason,
    summary: failure.reason
      ? `${path} operation=${operation} status=${status} reason=${failure.reason}`
      : `${path} operation=${operation} status=${status}`,
    messageKey: 'review.changedFile',
    messageArgs: { path, operation, status, reason: failure.reason ?? '' },
    auditRef: workUnitId ?? actionId,
  });
  if (workUnitId) auditRefs.push(workUnitId);
  if (actionId) auditRefs.push(actionId);
}

function addReviewToolFile(
  changedFiles: Map<string, ReadableReviewChangedFile>,
  auditRefs: string[],
  value: unknown
): void {
  const record = objectRecord(value);
  if (!record) return;
  const output = objectRecord(record.output);
  const path = reviewDisplayPath(output) ?? reviewDisplayPath(record);
  if (!path) return;
  const toolName = stringValue(record.toolName) ?? stringValue(output?.toolName);
  const actionId = stringValue(output?.actionId) ?? stringValue(record.actionId);
  const toolFactId = stringValue(record.toolCallId) ?? stringValue(record.factId);
  const operation = reviewOperation(output ?? record, toolName);
  const status = record.ok === false ? 'failed' : 'completed';
  const key = `${path}:${operation}:${toolFactId ?? actionId ?? status}`;
  const existing = changedFiles.get(key);
  const failure = status === 'failed' ? reviewFailureDetail(record, output) : {};
  changedFiles.set(key, {
    path,
    operation,
    status,
    actionId: actionId ?? existing?.actionId,
    workUnitId: existing?.workUnitId,
    toolFactIds: [...new Set([...(existing?.toolFactIds ?? []), toolFactId].filter((item): item is string => Boolean(item)))],
    failureClassification: failure.classification ?? existing?.failureClassification,
    failureReason: failure.reason ?? existing?.failureReason,
    summary: failure.reason
      ? `${path} operation=${operation} status=${status} reason=${failure.reason}`
      : `${path} operation=${operation} status=${status}`,
    messageKey: 'review.changedFile',
    messageArgs: { path, operation, status, reason: failure.reason ?? existing?.failureReason ?? '' },
    auditRef: toolFactId ?? actionId,
  });
  if (toolFactId) auditRefs.push(toolFactId);
  if (actionId) auditRefs.push(actionId);
}

function readableReviewChangedFileLines(readableReview: ReadableReviewSummary, language: VisibleLanguage): string[] {
  return readableReview.changedFiles.slice(0, 64).map((item) => {
    const ids = [
      item.actionId ? `action=${item.actionId}` : '',
      item.workUnitId ? `workUnit=${item.workUnitId}` : '',
      item.toolFactIds?.length ? `toolFacts=${item.toolFactIds.join(',')}` : '',
    ].filter(Boolean).join(' ');
    return `- \`${item.path}\` operation=${item.operation} status=${item.status}${ids ? ` ${ids}` : ''}`;
  }).concat(readableReview.changedFiles.length > 64
    ? [language === 'en-US'
      ? `- ${readableReview.changedFiles.length - 64} additional file-level change(s) are not expanded.`
      : `- 另有 ${readableReview.changedFiles.length - 64} 个文件级变更未展开。`]
    : []);
}

function reviewDisplayPath(record?: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined;
  return stringValue(record.path)
    ?? stringValue(record.targetPath)
    ?? stringValue(record.normalizedTargetPath)
    ?? stringValue(objectRecord(record.pathNormalization)?.normalizedTargetPath)
    ?? stringValue(record.absolutePath)
    ?? stringArrayValue(record.writeSet)[0]
    ?? stringArrayValue(record.deleteSet)[0];
}

function reviewFailureDetail(
  record?: Record<string, unknown> | null,
  output?: Record<string, unknown> | null
): { classification?: string; reason?: string } {
  const error = objectRecord(record?.error) ?? objectRecord(output?.error);
  const reason = stringValue(record?.message)
    ?? stringValue(record?.summary)
    ?? stringValue(error?.message)
    ?? stringValue(record?.reason)
    ?? stringValue(output?.message);
  const normalized = (reason ?? '').toLowerCase();
  const classification = normalized.includes('patch match did not occur')
    ? 'patch_stale_or_mismatched_evidence'
    : stringValue(record?.classification)
      ?? stringValue(output?.classification)
      ?? stringValue(record?.code)
      ?? stringValue(error?.code);
  return { classification, reason };
}

function reviewOperation(record?: Record<string, unknown> | null, toolName?: string): string {
  if (!record) return operationFromToolName(toolName);
  return stringValue(record.operation)
    ?? operationFromToolName(stringValue(record.toolName) ?? toolName)
    ?? stringValue(record.kind)
    ?? 'modify';
}

function operationFromToolName(toolName?: string): string {
  if (!toolName) return 'modify';
  if (toolName === 'fs.write') return 'write';
  if (toolName === 'fs.patch') return 'patch';
  if (toolName === 'fs.delete') return 'delete';
  if (toolName === 'fs.rename') return 'rename';
  if (toolName.startsWith('fs.')) return toolName.slice(3);
  return toolName;
}

function gitReviewSummaryLines(gitReview?: Record<string, unknown>, language: VisibleLanguage = 'zh-CN'): string[] {
  if (!gitReview) return [];
  if (gitReview.available === false) {
    const reason = stringValue(gitReview.reason) ?? 'Git review is unavailable.';
    return [language === 'en-US' ? `- Git diff unavailable: ${reason}` : `- Git diff 不可用：${reason}`];
  }
  const lines: string[] = [];
  const summary = stringValue(gitReview.summary);
  if (summary) lines.push(`- ${summary}`);
  const stats = objectRecord(gitReview.stats);
  const changedFiles = typeof stats?.changedFiles === 'number' ? stats.changedFiles : undefined;
  const stagedBytes = typeof stats?.stagedDiffBytes === 'number' ? stats.stagedDiffBytes : 0;
  const unstagedBytes = typeof stats?.unstagedDiffBytes === 'number' ? stats.unstagedDiffBytes : 0;
  if (changedFiles !== undefined) {
    lines.push(language === 'en-US'
      ? `- Files: ${changedFiles}; staged diff: ${stagedBytes} bytes; unstaged diff: ${unstagedBytes} bytes.`
      : `- 文件数：${changedFiles}；staged diff：${stagedBytes} bytes；unstaged diff：${unstagedBytes} bytes。`);
  }
  const files = Array.isArray(gitReview.files) ? gitReview.files : [];
  for (const item of files.slice(0, 12)) {
    const record = objectRecord(item);
    const path = stringValue(record?.path);
    if (path) lines.push(`- \`${path}\``);
  }
  if (files.length > 12) lines.push(language === 'en-US'
    ? `- ${files.length - 12} additional file(s) are not expanded in the summary.`
    : `- 另有 ${files.length - 12} 个文件未在摘要中展开。`);
  const diffBlocks = Array.isArray(gitReview.diffBlocks) ? gitReview.diffBlocks : [];
  if (diffBlocks.length) lines.push(language === 'en-US'
    ? '- Full diff is attached as collapsible Review evidence.'
    : '- 完整 diff 已附加为可折叠 Review 证据。');
  return lines;
}

function reviewGeneratedArtifactLines(reviewFacts?: Record<string, unknown>, language: VisibleLanguage = 'zh-CN'): string[] {
  const artifacts = Array.isArray(reviewFacts?.generatedArtifacts) ? reviewFacts.generatedArtifacts : [];
  return artifacts.slice(0, 24).map((item) => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? stringValue(record.absolutePath) ?? 'unknown';
    const operation = stringValue(record.operation) ?? stringValue(record.toolName) ?? 'write';
    const hash = stringValue(record.contentHash);
    return `- \`${path}\` operation=${operation}${hash ? ` contentHash=${hash}` : ''}`;
  }).concat(artifacts.length > 24
    ? [language === 'en-US'
      ? `- ${artifacts.length - 24} additional agentGenerated artifact(s) are not expanded.`
      : `- 另有 ${artifacts.length - 24} 个 agentGenerated 产物未展开。`]
    : []);
}

function reviewPathNormalizationLines(reviewFacts?: Record<string, unknown>, language: VisibleLanguage = 'zh-CN'): string[] {
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
  }).concat(diagnostics.length > 24
    ? [language === 'en-US'
      ? `- ${diagnostics.length - 24} additional path normalization diagnostic(s) are not expanded.`
      : `- 另有 ${diagnostics.length - 24} 条路径归一化诊断未展开。`]
    : []);
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

function reviewExpectationLines(plan: SessionPlanContext, language: VisibleLanguage = 'zh-CN'): string[] {
  const lines: string[] = [];
  if (plan.expectedValidation.trim()) {
    lines.push(language === 'en-US'
      ? `- Validation expectation: ${plan.expectedValidation.trim()}`
      : `- 验证要求：${plan.expectedValidation.trim()}`);
  }
  if (plan.reviewGuide.trim()) {
    lines.push(language === 'en-US'
      ? `- Review guide: ${plan.reviewGuide.trim()}`
      : `- Review 指引：${plan.reviewGuide.trim()}`);
  }
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
      '- actionBundle.actions 必须使用 actionId、toolId、args、description；fs.write 使用 args.path/sourceBlockId，fs.patch 使用 args.path/replacementBlockId/patchSpec，fs.delete 使用 args.path/targetKind/recursive。',
      '- codeBlocks 必须使用 contentLines；不得输出 commandBlocks、capability、permissionLabels、accessScopes、resourceScope 或大段 codeBlocks.content。',
      '- patch 必须包含 args.patchSpec.match.kind="exactBlock" 和当前 ResourcePacket 证据中的 exact text。',
      '- fs.delete action 必须明确相对文件 args.path；已确认目录删除必须额外设置 args.targetKind="directory"、args.recursive=true；不得使用 codeBlocks/sourceBlockId、空内容写入、fs.write 伪装删除、通配符或根目录。',
      '- 新 Plan 必须等待用户确认，不要假定已经执行。',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function implementationPlanExecutionRequest(
  plan: SessionPlanContext,
  acceptedPlan: AcceptedImplementationPlanContext,
  guidance?: string
): string {
  const currentTask = acceptedPlan.tasks.find((task) => !acceptedPlan.completedTaskIds.includes(task.taskId));
  const taskLedger = buildAcceptedPlanTaskLedger(acceptedPlan);
  const promptFrame = buildAcceptedPlanPromptFrameForContext(acceptedPlan, taskLedger);
  const providerContext = {
    sessionPlanId: plan.planId,
    ...sanitizedAcceptedPlanExecutionContext(acceptedPlan),
  };
  return [
    'The user accepted the Kernel execution contract. You are now in Edit stage and must generate the next executable candidate actionBundle.',
    'The accepted plan/contract is intent/checklist context, not execution fact. Do not claim files were created, tests passed, or permissions were granted.',
    'Before the final JSON proposal, stream visible edit drafts with <deepcode-part>{...}</deepcode-part> frames when generating long codeBlocks/actionBundles. Final workspace writes still come only from the complete actionBundle JSON.',
    'All user-visible natural language in narration, userPlanMarkdown, validation descriptions, and review guidance must follow the current user input language.',
    'Handle only the task referenced by the current task cursor. One actionBundle may contain multiple related files or actions required by that current task; file count, task count, and codeBlock count are not permission boundaries.',
    'The task list is a Session-advanced queue in the order confirmed by the user. Do not generate or reason about cross-task scheduling structures. Do not write continuationExpectations for later tasks; Session advances later tasks with its cursor.',
    'The nested actionBundle object must include version/id/goal/actions; goal is only this batch objective summary, not a permission grant, execution fact, or completion claim.',
    'actionBundle.actions must use actionId, toolId, args, and description; Kernel derives capability, permission, readSet/writeSet, and conflictKeys from toolId and args.',
    currentTask
      ? `Current task: taskId=${currentTask.taskId}; title=${currentTask.title ?? 'untitled'}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
      : 'The current task list is complete or unavailable; return diagnostic or a review-ready summary instead of expanding scope.',
    promptFrame
      ? `AcceptedPlanPromptFrame: stableFrameHash=${promptFrame.stableFrameHash.slice(0, 16)}; currentTask=${promptFrame.taskLedger.currentTaskId ?? 'none'}; completedTaskCount=${promptFrame.taskLedger.completedTaskIds.length}; remainingTaskCount=${promptFrame.taskLedger.pendingTaskIds.length + (promptFrame.taskLedger.currentTaskId ? 1 : 0)}; projectMemoryRefresh=${promptFrame.cachePolicy.projectMemoryRefresh}.`
      : '',
    acceptedPlan.completedTaskIds.length
      ? `Completed taskIds: ${acceptedPlan.completedTaskIds.join(', ')}. Do not regenerate completed tasks unless Kernel facts show failure or the user requests revision.`
      : 'The current accepted contract has no completed tasks yet.',
    acceptedPlan.executionRoot
      ? `Primary root: ${acceptedPlan.executionRoot.ref}. Workspace args.path and codeBlocks.targetPath must be relative to this root; do not include the root directory name or ../. Absolute file paths are allowed only for outside-workspace targets already confirmed in the accepted plan.`
      : 'Workspace args.path and codeBlocks.targetPath must be relative to the workspace root. Absolute file paths are allowed only for outside-workspace targets already confirmed in the accepted plan. Do not use ../.',
    'If this actionBundle stays inside the accepted contract target/tool scope, Session will submit it to Kernel execution. New target/tool needs must return decisionRequest instead of implicit expansion.',
    'Execution batches must not carry workspace root, ".", module root, wildcards, accessScopes, resourceScope, or capability; the confirmed Kernel contract is the authorization source.',
    'If an accepted task target is a directory such as src/, it is only a file grouping scope. Do not output directory-create actions, empty .gitkeep placeholder writes, or empty contentLines. Output concrete fs.write/fs.patch actions for files under that directory; Kernel creates parent directories for new file writes.',
    'Do not re-ask already confirmed technical route, directory layout, Docker/script workflow, module split, or validation strategy.',
    'If a new target/tool is required, or a key technical choice is missing, return kind="decisionRequest" instead of an out-of-scope actionBundle.',
    'This actionBundle must include concrete codeBlocks when needed and Kernel-reviewable validationExpectations/reviewExpectations. validationExpectations use [{id,description,command?}], and reviewExpectations use [{id,description}].',
    'When modifying an existing file, first use resourceRequest kind="search" or a file/range read for the current anchor. patch action must include patchSpec.match.kind="exactBlock" and non-empty patchSpec.match.text copied from current ResourcePacket fileText/searchResults.',
    'When deleting a file or confirmed directory, output an fs.delete action: toolId="fs.delete", args.path is a concrete path inside the confirmed task scope. Workspace targets use relative paths; confirmed external targets may use absolute paths. Delete actions do not need and must not reference codeBlocks/sourceBlockId.',
    'Directory deletion is allowed only when the accepted contract exposed an exact directory operation/grant; set args.targetKind="directory" and args.recursive=true. Unconfirmed directories, wildcards, root directories, and empty paths cannot be fs.delete actions.',
    `Keep total codeBlock content within the ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} byte payload budget. Prefer complete writes for new files when they fit. For large existing-file rewrites, slice by module, function, class, file section, script segment, or config segment. continuationExpectations may only record current-task payload or evidence deferral; they do not narrow accepted plan authorization and must not schedule later tasks.`,
    'All source content must be in codeBlocks[].contentLines. Do not use large or multiline codeBlocks.content.',
    guidance?.trim() ? `Additional guidance supplied when the user confirmed the plan:\n${guidance.trim()}` : '',
    `Accepted execution sanitized context:\n${fenced(JSON.stringify(providerContext, null, 2))}`,
  ].filter(Boolean).join('\n\n');
}

function acceptedPlanResourceResumePrompt(
  state: SessionDriverLoopRunState,
  requestProposal: ProposalEnvelope,
  packet: ResourcePacket
): string {
  const accepted = state.acceptedImplementationPlan;
  const cursor = state.taskExecutionCursor;
  const current = state.currentTaskContext;
  const resourceItems = packet.items.map((item) => {
    const record = objectRecord(item) ?? {};
    return {
      manifestEntryId: stringValue(record.manifestEntryId) ?? stringValue(record.id),
      path: stringValue(record.path) ?? stringValue(record.absolutePath) ?? stringValue(record.ref),
      kind: stringValue(record.contentKind) ?? stringValue(record.resolvedKind) ?? stringValue(record.kind),
      textPreview: clip(stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.fileText) ?? '', 1200),
    };
  });
  return [
    'Accepted-plan resource resume checkpoint.',
    'You are resuming the same accepted task after Session resolved read-only evidence. Do not restart planning, do not ask for already-confirmed scope, and do not claim execution facts.',
    'Before the final JSON proposal, stream visible edit drafts with <deepcode-part>{...}</deepcode-part> frames when generating long codeBlocks/actionBundles. These frames are draft ledger previews only; final workspace writes still come only from the complete actionBundle JSON.',
    'All user-visible natural language in narration, userPlanMarkdown, validation descriptions, and review guidance must follow the current user input language.',
    'Return exactly one Agent Protocol v3 proposal: actionBundle, resourceRequest, decisionRequest, answer, or diagnostic.',
    resourceRequestProtocolShapeLine(),
    'Prefer actionBundle if the just-resolved evidence is sufficient for an edit task. If the current task is read-only validation and the ResourcePacket is enough, return answer summarizing only the resolved evidence. If more evidence is needed, request only a different focused resource. If scope is insufficient, return decisionRequest.',
    accepted ? `Accepted plan: planId=${accepted.planId}; title=${accepted.title ?? accepted.summary ?? accepted.planId}; completedTaskCount=${accepted.completedTaskIds.length}; remainingTaskCount=${accepted.tasks.filter((task) => !accepted.completedTaskIds.includes(task.taskId)).length}.` : '',
    cursor ? `TaskExecutionCursor: cursorId=${cursor.cursorId}; currentTaskId=${cursor.currentTaskId ?? 'none'}; completedTaskCount=${cursor.completedTaskIds.length}; remainingTaskCount=${cursor.pendingTaskIds.length + (cursor.currentTaskId ? 1 : 0)}; lastResourcePackets=${cursor.lastResourcePacketIds.join(', ') || 'none'}.` : '',
    current ? `CurrentTaskGoal: ${current.goal}` : '',
    current ? `CurrentTaskContext: targets=${current.targets.join(', ') || 'none'}; capabilities=${current.capabilities.join(', ') || 'none'}; evidenceNeeds=${current.evidenceNeeds.join(', ') || 'none'}.` : '',
    `Original resourceRequest proposalId=${requestProposal.proposalId}; kind=${requestProposal.kind}.`,
    `Resolved ResourcePacket id=${packet.id}; itemCount=${packet.items.length}:`,
    fenced(clip(JSON.stringify(resourceItems, null, 2), 6_000)),
    'ActionBundle constraints: use concrete tool actions only; codeBlocks use contentLines; patch match text must come from the resolved ResourcePacket or another fresh ResourcePacket; new files may be complete writes if in accepted scope.',
    'Directory targets are planning scopes only. Do not output empty .gitkeep or placeholder writes to create directories; write concrete files and let Kernel create parent directories.',
  ].filter(Boolean).join('\n\n');
}

function planRevisionRequest(plan: SessionPlanContext, guidance?: string): string {
  const report = plan.planReviewReport ? clipJson(plan.planReviewReport, 4_000) : '';
  return [
    'The user revised the pending plan card. Generate a new reviewable taskPlan from the same user goal and the revision guidance.',
    'This is plan revision, not plan acceptance. Do not execute work, do not output actionBundle, and do not claim any files were changed.',
    guidance?.trim() ? `User plan revision guidance:\n${guidance.trim()}` : 'User plan revision guidance: revise the pending plan before execution.',
    plan.userPlan ? `Previous plan card content:\n${clip(plan.userPlan, 6_000)}` : '',
    report ? `Previous Kernel PlanReview report, clipped:\n${report}` : '',
    [
      'Next proposal requirements:',
      '- Prefer kind="taskPlan" with a complete non-executable plan that waits for user confirmation.',
      '- If more read-only evidence is required before planning, return resourceRequest.',
      '- If a material user choice is still required, return decisionRequest.',
      '- Do not return actionBundle until the revised plan is explicitly accepted.',
      '- Keep targets and capabilities concrete enough for Kernel PlanReview, but do not include codeBlocks or executable tool actions in taskPlan.',
    ].join('\n'),
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
      '- actionBundle.actions 必须使用 actionId、toolId、args、description；fs.write 使用 args.path/sourceBlockId，fs.patch 使用 args.path/replacementBlockId/patchSpec，fs.delete 使用 args.path/targetKind/recursive。',
      '- codeBlocks 必须使用 contentLines；不得输出 commandBlocks、capability、permissionLabels、accessScopes、resourceScope 或大段 codeBlocks.content。',
      '- patch 必须包含 args.patchSpec.match.kind="exactBlock" 和当前 ResourcePacket 证据中的 exact text。',
      '- fs.delete action 必须明确相对文件 args.path；已确认目录删除必须额外设置 args.targetKind="directory"、args.recursive=true；不得使用 codeBlocks/sourceBlockId、空内容写入、fs.write 伪装删除、通配符或根目录。',
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
  let direct: AgentEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'requirement_confirmation') continue;
    const payload = objectRecord(event.payload);
    if (!payload || payload.confirmable !== true) continue;
    const candidateRunId = stringValue(payload.runId);
    const candidateRequirementId = stringValue(payload.requirementId);
    if (runId && candidateRunId !== runId) continue;
    if (requirementId && candidateRequirementId !== requirementId) continue;
    if (!candidateRunId || !candidateRequirementId) continue;
    if (stringValue(payload.status) !== 'waitingUserConfirmation') continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    if (requirementAlreadyResolved(events, candidateRunId, candidateRequirementId)) continue;
    direct = event;
    break;
  }
  if (direct) return direct;

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
  const overlayPayload = interactionOverlayProjection(interactionOverlayFromPayload(payload));
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
      ...overlayPayload,
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
  effect?: unknown;
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
      effect: record.effect,
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

function requirementDecisionResumeRequest(
  confirmation: AgentEvent,
  decisionEvent: AgentEvent,
  decision: 'accept' | 'reject' | 'revise',
  guidance?: string
): string {
  const originalRequest = requirementOriginalRequest(confirmation);
  if (decision === 'revise') {
    return guidance?.trim()
      ? `${originalRequest}\n\n用户修订意见：${guidance.trim()}`
      : `${originalRequest}\n\n用户要求修订当前用户介入请求。`;
  }
  if (decision !== 'accept') return originalRequest;
  const payload = objectRecord(decisionEvent.payload);
  const selectedOption = objectRecord(payload?.selectedOption);
  const lines = [
    originalRequest,
    '',
    '用户已完成用户介入选择，请基于该选择继续当前父流程；不要重复输出同一个 decisionRequest，除非后续出现新的独立决策点。',
  ];
  const id = stringValue(selectedOption?.id);
  const label = stringValue(selectedOption?.label);
  const description = stringValue(selectedOption?.description);
  if (id || label || description) {
    lines.push('', '已选择的选项：');
    if (id) lines.push(`- id: ${id}`);
    if (label) lines.push(`- label: ${label}`);
    if (description) lines.push(`- description: ${description}`);
  }
  if (guidance?.trim()) {
    lines.push('', '用户补充信息：', guidance.trim());
  }
  return lines.join('\n');
}

function acceptedPlanExecutionRequirementResumeRequest(
  confirmation: AgentEvent,
  decisionEvent: AgentEvent,
  decision: 'accept' | 'reject' | 'revise',
  guidance?: string
): string {
  return [
    requirementDecisionResumeRequest(confirmation, decisionEvent, decision, guidance),
    '',
    'Accepted-plan continuation rule:',
    '- This decision belongs to the current accepted implementationPlan execution checkpoint.',
    '- Continue the same accepted taskPlan and current task cursor.',
    '- Do not create a new standalone plan or final Review unless all accepted tasks are complete.',
    '- If returning actionBundle, keep targets and capabilities inside the accepted plan scope.',
  ].join('\n');
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

function compactRepairContextLines(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  options?: { includeImplementationBatch?: boolean; includeAcceptedPlan?: boolean }
): string[] {
  const roots = clip(JSON.stringify(state.conversationRoots, null, 2), 2_000);
  const packets = clip(JSON.stringify(state.resourcePackets.slice(-6), null, 2), 6_000);
  const lines = [
    'Current user goal summary:',
    fenced(clip(state.userRequest, 1_200)),
    'Available conversation roots summary:',
    fenced(roots || '[]'),
    'Recent ResourcePacket summary, clipped:',
    fenced(packets || '[]'),
    'Prompt envelope size summary, content intentionally omitted from repair:',
    fenced(JSON.stringify({
      stablePrefixChars: prompt.stablePrefix.length,
      dynamicSuffixChars: prompt.dynamicSuffix.length,
    }, null, 2)),
  ];
  if (options?.includeImplementationBatch) {
    lines.push('Implementation batch context summary:', fenced(clip(JSON.stringify(state.implementationBatch, null, 2), 2_000)));
  }
  if (options?.includeAcceptedPlan) {
    lines.push('Accepted plan context summary:', fenced(clip(JSON.stringify(sanitizedAcceptedPlanExecutionContext(state.acceptedImplementationPlan), null, 2), 3_000)));
  }
  return lines;
}

function minimalActionBundleRepairSkeleton(): string {
  return JSON.stringify({
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'zh-CN',
    userPlanMarkdown: '# Plan\n\n## Summary\n...\n\n## Key Changes\n...\n\n## Interfaces\n...\n\n## Test Plan\n...\n\n## Assumptions\n...',
    codeBlocks: [
      {
        blockId: 'block-1',
        targetPath: 'relative/file.ext',
        language: 'text',
        operation: 'create',
        contentLines: ['line 1', 'line 2'],
      },
    ],
    actionBundle: {
      version: '1',
      id: 'batch-id',
      goal: '...',
      actions: [
        {
          actionId: 'write-file',
          toolId: 'fs.write',
          args: { path: 'relative/file.ext', sourceBlockId: 'block-1' },
          description: 'Create the file.',
        },
      ],
      validationExpectations: [{ id: 'validation-1', description: 'Kernel facts show the expected file operation.' }],
      reviewExpectations: [{ id: 'review-1', description: 'Review the written file and Kernel facts.' }],
    },
  }, null, 2);
}

// S4：协议解析/repair 失败 → 结构化 DiagnosticInfo，英文 fallback + code，不含硬编码中文。
function readableDriverFailureMessage(code: string, message: string): DiagnosticInfo {
  const protocolFailureCodes = new Set([
    'agent_protocol_repair_failed',
    'accepted_plan_resource_resume_repair_failed',
    'invalid_json_envelope',
    'invalid_action_bundle',
    'invalid_action_bundle_expectation',
    'invalid_action_bundle_continuation',
  ]);
  if (!protocolFailureCodes.has(code)) return diag('generic', message, { message });
  const fallback = `${message}\n\nThe model output could not form a valid structured proposal (protocol format issue); automatic repair was attempted but unsuccessful. Previously completed steps are not affected. You may retry this turn or rephrase your request.`;
  return diag('protocolRepairFailed', fallback, { message });
}

// S5：provider 调用/网络层失败 → 结构化 DiagnosticInfo，英文 fallback + code。
function readableProviderFailureMessage(error: unknown): DiagnosticInfo {
  const raw = (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';
  const fallback = `Model call failed: ${raw}\n\nThe connection to the model was interrupted (possibly due to network fluctuation, provider timeout, or response stream closure). Previously completed steps are not affected; please retry this turn.`;
  return diag('providerCallFailed', fallback, { raw });
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
        'Allowed proposal kinds: answer, resourceRequest, decisionRequest, taskPlan, actionBundle, diagnostic.',
        'For initial side-effect work, output taskPlan unless acceptedTaskPlan context is already present. For Complete stage work after acceptedTaskPlan, output a smaller actionBundle batch.',
        ...actionBundleProtocolShapeLines(),
        'Use codeBlocks[].contentLines for source code. Do not output large codeBlocks.content strings and do not manually escape multiline source code into JSON strings.',
        'For fs.write, args.sourceBlockId must reference a top-level codeBlocks[].blockId for the same args.path. Directory targets are planning scopes; do not repair by creating empty .gitkeep or other placeholder files.',
        'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or payload wrapper fields.',
        'Output ONLY the single JSON object — no prose, no explanation, and no markdown ``` code fences before or after it.',
        'actionBundle.version must be exactly the string "1".',
        'For a side-effect actionBundle, actionBundle.validationExpectations must be a non-empty array of { id, description }.',
        'Repair once from the compact context only; do not rely on omitted prompt text.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        ...compactRepairContextLines(prompt, state),
        'Protocol field quick reference:',
        fenced(protocolRepairShapeReference(parseError.code)),
        `Parser error code: ${parseError.code}`,
        `Parser error message: ${parseError.message}`,
        'Invalid model output, clipped:',
        fenced(clip(invalidOutput, 4_000)),
      ].join('\n\n'),
    },
  ];
}

function protocolRepairShapeReference(errorCode: string): string {
  const common = [
    'Provider output must be one Agent Protocol v3 JSON object.',
    'Allowed proposal kinds: answer, resourceRequest, decisionRequest, taskPlan, actionBundle, diagnostic.',
    'reviewSummary is Session-generated and must not be returned by the provider.',
    'For kind="taskPlan", put taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints at the top level. tasks[] must be a Session-advanced ordered engineering queue, not a graph. Deprecated graph fields may be parsed for telemetry but are not required and must not be used for provider-facing scheduling. It must not include codeBlocks, actionBundle, commandBlocks, patches, source code, or executable tool calls.',
    'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. Put validation notes in actionBundle.validationExpectations[] and review obligations in actionBundle.reviewExpectations[].',
    'For kind="decisionRequest", put decisionRequest:{id,question,reason?,summary?,options:[{id,label,description,recommended?}],allowsFreeform?} on the top-level JSON object. Do not return bare reason/options without decisionRequest.',
    'codeBlocks[] uses {blockId,targetPath,language?,operation?,contentLines,allowEmptyContent?}; contentLines is the only source-code carrier.',
    'fs.write actions use args={path,sourceBlockId}; sourceBlockId must match the blockId of the codeBlock carrying that exact file content.',
    'Directory targets such as src/ are planning scopes only. Do not create empty .gitkeep or placeholder files unless the user explicitly requested that concrete file. For new files, write the concrete file and let Kernel create parent directories.',
    'Empty content is valid only for operation="createEmpty" on an explicit empty file, or for patch/replace/insert operations when the protocol explicitly permits it.',
    actionBundleProtocolShapeReference(),
    'Never output capability, permissionLabels, accessScopes, resourceScope, commandBlocks, or legacy implementationPlan.',
  ];
  if (errorCode === 'invalid_action_bundle' || errorCode === 'invalid_object') {
    common.push(
      `Minimal actionBundle skeleton:\n${minimalActionBundleRepairSkeleton()}`
    );
  }
  return common.join('\n');
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
        'If proposing executable work, return kind="actionBundle" for a coherent batch that fits the payload budget.',
        'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. Put validation notes in actionBundle.validationExpectations[] and review obligations in actionBundle.reviewExpectations[].',
        ...actionBundleProtocolShapeLines(),
        'Use codeBlocks[].contentLines for source code.',
        'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
        `Payload budget: at most ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} bytes total joined contentLines. File count, task count, and codeBlock count are not permission boundaries.`,
        'For new files, prefer one complete file write when it fits the payload budget. For large rewrites, split by module, file section, class, function, or script/config section. continuationExpectations may describe current-task payload or evidence-delayed work, but must not reduce the accepted plan scope or schedule later tasks.',
        'Directory targets are planning scopes only. Do not create empty .gitkeep or placeholder writes for directories; output concrete file writes and reference each file content with args.sourceBlockId.',
        'If current facts are insufficient, return kind="resourceRequest" using manifestEntryId, rootId+path, or kind="search" with a non-empty query under the listed conversation roots.',
        'Do not claim execution, permissions, tests passed, or task completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        ...compactRepairContextLines(prompt, state, { includeImplementationBatch: true }),
        `Repair reason: ${reason}`,
        'Invalid or empty model output, clipped:',
        fenced(clip(invalidOutput || '[empty response]', 4_000)),
      ].join('\n\n'),
    },
  ];
}

function completeStageToolViolationRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  toolCall: NativeToolCallProposal,
  turn: LlmTurnResult
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode accepted-plan proposal-only repair step.',
        'Complete-stage provider-native tools are disabled. Do not call tools.',
        'Return exactly one valid Agent Protocol v3 JSON object.',
        'If executable work is ready, return kind="actionBundle" within the accepted taskPlan scope.',
        'If evidence is missing, return kind="resourceRequest". If the accepted scope is insufficient, return kind="decisionRequest" or diagnostic.',
        'Never claim that files were written, commands ran, permissions were granted, validation passed, or tasks completed.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Blocked native tool during Complete stage: ${toolCall.name}`,
        `Tool call id: ${toolCall.callId}`,
        'Tool arguments:',
        fenced(JSON.stringify(toolCall.arguments, null, 2)),
        'Provider narration before blocked tool:',
        fenced(clip(turn.content || '[empty]', 2_000)),
        ...compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
        'Minimum actionBundle skeleton:',
        fenced(minimalActionBundleRepairSkeleton()),
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
  const requestedKind = afterAcceptedPlan ? 'actionBundle' : 'decisionRequest-or-taskPlan';
  const guardrail = afterAcceptedPlan
    ? 'A plan/contract has already been accepted. Return kind="actionBundle" only for the next related batch within the accepted scope. Multiple related files are allowed when all target paths stay in scope. Use workspace-relative target paths by default; absolute paths are allowed only for outside-workspace files already reviewed in the accepted contract.'
    : 'Return kind="decisionRequest" if a material engineering choice needs user selection; otherwise return kind="taskPlan" with the non-executable Plan/Check task slices. Do not return actionBundle before taskPlan acceptance.';
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
        'If returning taskPlan, put taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints directly on the top-level JSON object. tasks[] must be ordered by practical development sequence; deprecated graph fields may be parsed for telemetry but are not required. taskPlan must not include source code, codeBlocks, actionBundle, commandBlocks, patches, or executable tool calls.',
        'If returning actionBundle after acceptedTaskPlan, put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. Put validation notes in actionBundle.validationExpectations[] and review obligations in actionBundle.reviewExpectations[].',
        ...actionBundleProtocolShapeLines(),
        'Command plans use actionBundle.actions[] with toolId="process.exec" and typed args; do not output commandBlocks.',
        'Use codeBlocks[].contentLines for source code in Complete-stage actionBundle only. Do not output capability, permissionLabels, accessScopes, resourceScope, commandBlocks, legacy implementationPlan, or large/multiline codeBlocks.content strings.',
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
        ...compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
      ].join('\n\n'),
    },
  ];
}

function nativeToolDuplicateRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  turn: LlmTurnResult,
  duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
): LlmChatRequest['messages'] {
  const afterAcceptedPlan = Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1;
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 duplicate native read repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Do not call tools. The provider has repeatedly requested the same read-only native tool target/range after Session already returned Kernel ResourcePacket facts.',
        afterAcceptedPlan
          ? 'A plan has already been accepted. If executable work is ready, return kind="actionBundle" within the accepted plan scope.'
          : 'If enough facts are available, return kind="answer"; otherwise return kind="resourceRequest" only for a different target/range or search query that adds new evidence.',
        'Never request fs.read or fs.list for any duplicate target/range listed below. Use the existing ResourcePacket facts.',
        'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. Put validation notes in actionBundle.validationExpectations[] and review obligations in actionBundle.reviewExpectations[].',
        ...actionBundleProtocolShapeLines(),
        'Use codeBlocks[].contentLines for source code.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Duplicate native read targets:',
        fenced(JSON.stringify(duplicates.map((item) => ({
          callId: item.toolCall.callId,
          toolName: item.toolCall.name,
          signature: item.signature,
          packetId: item.entry.packet.id,
          contentHash: item.entry.contentHash,
          repeatCount: item.entry.repeatCount,
        })), null, 2)),
        'Provider narration before duplicate tool call:',
        fenced(turn.content || '[empty]'),
        ...compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
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
        resourceRequestProtocolShapeLine(),
        'Use kind="decisionRequest" only when user input is required; minimal shape is {"schemaVersion":"deepcode.agent.protocol.v3","kind":"decisionRequest","decisionRequest":{"id":"decision-1","question":"...","options":[{"id":"option-1","label":"...","description":"...","effect":{"kind":"continueWithAction"}},{"id":"option-2","label":"...","description":"...","effect":{"kind":"continueWithAction"}}],"allowsFreeform":true}}.',
        'Each decisionRequest option SHOULD declare its state-machine effect via option.effect. Allowed kinds: "continueWithAction" (default, generate next actionBundle), "skipCurrentTask" (skip the current accepted-plan task), "markAcceptedIncomplete" with optional taskIds[] and reason, "replan" with reason, "finishWithAnswer", and "cancel". When the user-visible question implies "the task is already satisfied / nothing to do / stop and summarize", at least one option MUST use skipCurrentTask, markAcceptedIncomplete, or finishWithAnswer so the session can advance without forcing an empty actionBundle.',
        'Do not invent arbitrary absolute local paths. Absolute file paths are only for user-provided outside-workspace targets that require Kernel PlanReview/permission.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        ...compactRepairContextLines(prompt, state),
        'Invalid or unresolved resourceRequest proposal:',
        fenced(clip(JSON.stringify(proposal.payload, null, 2), 4_000)),
        'Resolution diagnostic:',
        fenced(resourceResolutionDiagnostic(resolution).fallback),
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
        ...actionBundleProtocolShapeLines(),
        'Kernel derives permissions and scope from normalized action args.',
        'Use codeBlocks[].contentLines for source code. Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
        'Do not add new toolIds or expand targets unless the Kernel report explicitly requires a repairable correction.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        ...compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
        'Original ProposalEnvelope:',
        fenced(clip(JSON.stringify(proposal, null, 2), 5_000)),
        'Kernel PlanReview report:',
        fenced(clip(JSON.stringify(report, null, 2), 5_000)),
        'Repair requirement:',
        fenced('For side-effect actions, include detailed structured Markdown userPlan. It must cover summary, changes, interfaces or affected surfaces, validation or test plan, and assumptions or constraints; headings may be localized to the user language. Include non-empty actionBundle.validationExpectations as [{id,description,command?}] and actionBundle.reviewExpectations as [{id,description}]. Each validation expectation must describe evidence Kernel or the user can inspect after execution. Use toolId+typed args only.'),
      ].join('\n\n'),
    },
  ];
}

function actionBundleAdmissionRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  reasons: string[]
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 actionBundle admission repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'The current actionBundle is not allowed to become a confirmable plan card because Session detected delete targets that are not concrete enough for Kernel review.',
        'fs.delete must use toolId="fs.delete" with args.path as a concrete target. Workspace targets should use relative paths; user-confirmed outside targets may use absolute paths.',
        'Directory delete actions are allowed only when the provider explicitly requests a concrete directory target with args.targetKind="directory" and args.recursive=true so Kernel PlanReview can show that exact sensitive operation on the plan card.',
        'Do not output wildcard cleanup, workspace root cleanup, empty target cleanup, or fs.write disguised as delete. If the user intent mentions clearing a directory but you cannot identify the exact directory target, return resourceRequest/decisionRequest instead of guessing.',
        'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
        'If current evidence is insufficient to enumerate concrete files, return kind="resourceRequest" for a directoryTree/file/search read instead of guessing.',
        'If the deletion scope is ambiguous or needs a user choice, return kind="decisionRequest".',
        'Do not claim execution, permissions, tests passed, or task completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        ...compactRepairContextLines(prompt, state),
        'Invalid ProposalEnvelope:',
        fenced(clip(JSON.stringify(proposal, null, 2), 5_000)),
        'Session admission reasons:',
        fenced(reasons.map((reason) => `- ${reason}`).join('\n')),
        'Repair requirement:',
        fenced('Return a corrected actionBundle with concrete file targets or explicit directory targets shaped {actionId:"delete-dir",toolId:"fs.delete",args:{path:"relative/dir",targetKind:"directory",recursive:true},description:"..."}. Return resourceRequest/decisionRequest if evidence or user confirmation is required. Do not return workspace root, wildcard, empty target, or ambiguous directory cleanup.'),
      ].join('\n\n'),
    },
  ];
}

function actionBundleAdmissionResourceFollowupRequest(
  state: SessionDriverLoopRunState,
  reasons: string[]
): string {
  return [
    'Session 已补充 actionBundle admission 所需的只读资源证据。',
    '请继续生成同一用户请求的可确认计划，但必须满足具体目标删除约束。',
    'fs.delete 必须使用 toolId="fs.delete" 和 args.path 列出具体文件或显式目录；workspace 目标使用相对路径，已确认的外部目标使用绝对路径。目录删除必须写成 args.targetKind="directory"、args.recursive=true，供 Kernel PlanReview 展示并申请用户确认；不得输出通配符、根目录或空目标。',
    '如果 ResourcePacket 显示某个目标是目录，且用户意图确实是删除该目录，可以保留该目录 path 并显式 args.targetKind="directory"/args.recursive=true；如果目录范围不确定，请返回 decisionRequest。',
    '如果仍无法确认具体文件范围，请返回 decisionRequest，而不是输出不可执行 actionBundle。',
    reasons.length ? `上一次 admission 拒绝原因：\n${reasons.map((reason) => `- ${reason}`).join('\n')}` : '',
    `当前 runId: ${state.runId}`,
  ].filter(Boolean).join('\n\n');
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
        'A user has already accepted an execution contract. Repair the current batch so it stays inside the accepted task targets and tool scope.',
        'If executable work is still valid, return kind="actionBundle" with one related implementation batch. Multiple related files are allowed when all targets are inside the accepted plan.',
        'Before the final JSON proposal, stream visible edit drafts with <deepcode-part>{...}</deepcode-part> frames when generating long codeBlocks/actionBundles. Final workspace writes still come only from the complete actionBundle JSON.',
        'All user-visible natural language in narration, userPlanMarkdown, validation descriptions, and review guidance must follow the current user input language.',
        'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. Put validation notes in actionBundle.validationExpectations[] and review obligations in actionBundle.reviewExpectations[].',
        ...actionBundleProtocolShapeLines(),
        resourceRequestProtocolShapeLine(),
        'Use codeBlocks[].contentLines for source code.',
        'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
        'Accepted-plan execution batches should not request workspace root, ".", module root, wildcard, or traversal scope. The accepted Kernel contract is already the authorization source; list concrete args.path/codeBlock.targetPath instead.',
        'If a patch needs current file evidence, return kind="resourceRequest" with kind="search" or a focused file/range read under the conversation roots; Session will resolve it and resume the accepted plan.',
        'Patch actions must use patchSpec.match.kind="exactBlock" and patchSpec.match.text copied from current ResourcePacket fileText/searchResults evidence.',
        'If the accepted contract is missing a required exact file/folder target, tool, or material technical choice, return kind="decisionRequest" instead of expanding the batch.',
        'For decisionRequest options that continue the same accepted task, include option.effect. Use effect.kind="expandCurrentTaskScope" with taskId, targetPath, targetResourceKind="file"|"directory", recursive=true when asking the user to approve a concrete folder/file expansion. Use effect.kind="continueCurrentTask" only when no scope expansion is needed. Use effect.kind="replan" only when the user must revise the accepted plan.',
        'Do not claim execution, permissions, tests passed, or task completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        ...compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
        'Accepted task context:',
        fenced(clip(JSON.stringify(sanitizedAcceptedPlanExecutionContext(state.acceptedImplementationPlan), null, 2), 4_000)),
        'Invalid ProposalEnvelope:',
        fenced(clip(JSON.stringify(proposal, null, 2), 5_000)),
        'Session validation reasons:',
        fenced(validation.reasons.map((reason) => `- ${reason}`).join('\n')),
        'Repair requirement:',
        fenced('Return a corrected actionBundle within the accepted contract scope. Minimal patch shape: {"schemaVersion":"deepcode.agent.protocol.v3","kind":"actionBundle","outputLanguage":"zh-CN","userPlanMarkdown":"# Plan\\n\\n## Summary\\n...","codeBlocks":[{"blockId":"block-1","targetPath":"relative/file.ext","contentLines":["replacement line"]}],"actionBundle":{"version":"1","id":"batch-id","goal":"...","actions":[{"actionId":"patch-file","toolId":"fs.patch","args":{"path":"relative/file.ext","replacementBlockId":"block-1","patchSpec":{"match":{"kind":"exactBlock","text":"..."}}},"description":"..."}],"validationExpectations":[{"id":"validation-1","description":"..."}],"reviewExpectations":[{"id":"review-1","description":"..."}]}}. Do not add accessScopes/resourceScope/capability/commandBlocks/payload wrapper. If current patch evidence is missing, return resourceRequest search/read first. Return decisionRequest only if scope expansion is truly required, and include option.effect so Session can resume the same task without re-planning.'),
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
  interactionOverlay?: InteractionOverlayContext;
  ts: string;
  id: string;
}): AgentEvent {
  const decisionRequest = objectRecord(input.proposal.payload);
  const language = visibleLanguageForRequest(input.originalUserRequest);
  const content = decisionRequest && isDecisionRequestPayload(decisionRequest)
    ? renderDecisionRequestMarkdown(decisionRequest, language)
    : renderRequirementConfirmationMarkdown(input.requirement);
  const summary = decisionRequestSummary(decisionRequest) ?? requirementSummary(input.requirement);
  const overlayPayload = interactionOverlayProjection(input.interactionOverlay);
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
      ...overlayPayload,
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function acceptedPlanAccessScopesCanonicalizedEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  canonicalization: AcceptedPlanAccessScopeCanonicalizationResult,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      title: 'Accepted plan access scope canonicalized',
      summary: 'Session removed invalid execution-batch accessScopes before Kernel PlanReview.',
      stage: 'accepted_plan.access_scope_canonicalized',
      status: 'completed',
      runId,
      planId: accepted.planId,
      removedAccessScopes: canonicalization.removedAccessScopes,
      actionTargets: [...new Set(canonicalization.actionTargets.filter(Boolean))],
      reason: 'invalid_execution_scope',
      channel: 'progress',
      visibility: 'debug',
      presentation: 'collapsible',
    },
  };
}

function isResourceBudgetConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const requirementId = stringValue(payload?.requirementId);
  return Boolean(requirementId?.startsWith(`${RESOURCE_BUDGET_REQUIREMENT_PREFIX}-`));
}

function isAcceptedPlanScopeConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const decisionRequest = objectRecord(payload?.decisionRequest);
  return stringValue(decisionRequest?.decisionScope) === 'acceptedPlanBatchOutOfScope';
}

function isAcceptedPlanExecutionConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const overlay = interactionOverlayFromPayload(payload);
  return Boolean(overlay?.acceptedPlanId);
}

function selectedRequirementDecisionOptionId(event: AgentEvent): string | undefined {
  const payload = objectRecord(event.payload);
  const selectedOption = objectRecord(payload?.selectedOption);
  return stringValue(selectedOption?.id);
}

// R2：读取用户接受的 option 上声明的状态机副作用（effect）。
// 缺失/非法时返回 undefined，调用方按 continueWithAction 处理（向下兼容）。
function selectedRequirementDecisionOptionEffect(event: AgentEvent): RequirementOptionEffect | undefined {
  const payload = objectRecord(event.payload);
  const selectedOption = objectRecord(payload?.selectedOption);
  const effect = objectRecord(selectedOption?.effect);
  if (!effect) return undefined;
  const kind = stringValue(effect.kind);
  if (!kind) return undefined;
  switch (kind) {
    case 'continueWithAction':
    case 'skipCurrentTask':
    case 'finishRun':
    case 'finishWithAnswer':
      return { kind } as RequirementOptionEffect;
    case 'continueCurrentTask': {
      const taskId = stringValue(effect.taskId);
      return taskId ? { kind: 'continueCurrentTask', taskId } : { kind: 'continueCurrentTask' };
    }
    case 'expandCurrentTaskScope': {
      const taskId = stringValue(effect.taskId);
      const targetPath = stringValue(effect.targetPath);
      const targetKind = stringValue(effect.targetResourceKind);
      const targetResourceKind = targetKind === 'directory' || targetKind === 'file' ? targetKind : undefined;
      const reason = stringValue(effect.reason);
      return {
        kind: 'expandCurrentTaskScope',
        ...(taskId ? { taskId } : {}),
        ...(targetPath ? { targetPath } : {}),
        ...(targetResourceKind ? { targetResourceKind } : {}),
        ...(effect.recursive === true ? { recursive: true } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'confirmOperationGrant':
    case 'answerReviewQuestion': {
      const taskId = stringValue(effect.taskId);
      const reason = stringValue(effect.reason);
      return {
        kind,
        ...(taskId ? { taskId } : {}),
        ...(reason ? { reason } : {}),
      } as RequirementOptionEffect;
    }
    case 'cancel': {
      const reason = stringValue(effect.reason);
      return reason ? { kind: 'cancel', reason } : { kind: 'cancel' };
    }
    case 'markAcceptedIncomplete': {
      const taskIds = Array.isArray(effect.taskIds)
        ? effect.taskIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : undefined;
      const reason = stringValue(effect.reason);
      return {
        kind: 'markAcceptedIncomplete',
        ...(taskIds?.length ? { taskIds } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'replan': {
      const reason = stringValue(effect.reason);
      return reason ? { kind: 'replan', reason } : { kind: 'replan' };
    }
    default:
      return undefined;
  }
}

// R2：用户介入卡 option 的状态机副作用合约（运行时类型，与 protocolV3 normalizeOptionEffect 对齐）。
type RequirementOptionEffect =
  | { kind: 'continueWithAction' }
  | { kind: 'skipCurrentTask' }
  | { kind: 'continueCurrentTask'; taskId?: string }
  | {
    kind: 'expandCurrentTaskScope';
    taskId?: string;
    targetPath?: string;
    targetResourceKind?: 'file' | 'directory';
    recursive?: boolean;
    reason?: string;
  }
  | { kind: 'confirmOperationGrant'; taskId?: string; reason?: string }
  | { kind: 'answerReviewQuestion'; reason?: string }
  | { kind: 'replan'; reason?: string }
  | { kind: 'finishRun' }
  | { kind: 'markAcceptedIncomplete'; taskIds?: string[]; reason?: string }
  | { kind: 'finishWithAnswer'; reason?: string }
  | { kind: 'cancel'; reason?: string };

function acceptedPlanScopeRevisionRequest(
  confirmation: AgentEvent,
  plan: SessionPlanContext | null,
  guidance?: string
): string {
  const decisionRequest = objectRecord(objectRecord(confirmation.payload)?.decisionRequest) ?? {};
  const implementationPlan = objectRecord(plan?.implementationPlan);
  const planSummary = plan
    ? {
        planId: plan.planId,
        title: stringValue(implementationPlan?.title),
        summary: stringValue(implementationPlan?.summary),
      }
    : undefined;
  return [
    'User requested an accepted-plan scope revision.',
    'Return a decisionRequest if a new user choice is required, or return a new actionBundle if the requested revision is already precise enough.',
    'Do not output legacy implementationPlan, fileOperations, accessScopes, capability, resourceScope, commandBlocks, or large/multiline codeBlocks.content.',
    'Only expand targets or toolIds when the user guidance or Kernel review reason requires it. Kernel will review the resulting execution contract and the user must confirm it before execution continues.',
    guidance?.trim() ? `User guidance:\n${guidance.trim()}` : '',
    planSummary ? `Current accepted execution summary:\n${JSON.stringify(planSummary, null, 2)}` : '',
    Object.keys(decisionRequest).length ? `Accepted-plan scope decision:\n${JSON.stringify(decisionRequest, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
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

function actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string {
  const capability = stringValue(action.capability);
  if (capability) return capability;
  const toolId = stringValue(action.toolId);
  if (!toolId) return '';
  if (toolId === 'git.status' || toolId === 'git.diff') return 'git.read';
  if (toolId === 'git.push') return 'git.push';
  if (toolId.startsWith('git.')) return 'git.write';
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
}

function actionFileTargetPath(action: { targetRef?: unknown; targetPath?: unknown; resourceScope?: unknown; args?: unknown }): string | undefined {
  const args = objectRecord(action.args);
  return fileTargetRefPath(action.targetRef)
    ?? stringValue(action.targetPath)
    ?? stringArrayValue(action.resourceScope)[0]
    ?? stringValue(args?.path)
    ?? stringValue(args?.targetPath);
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
}

function fileTargetRefFromPath(path: string): Record<string, unknown> {
  return {
    kind: isAbsolutePath(path) ? 'absolutePath' : 'workspaceRelative',
    path,
  };
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
  if (record && (Array.isArray(record.messages) || record.contextAssembly || record.cachePlan)) {
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
