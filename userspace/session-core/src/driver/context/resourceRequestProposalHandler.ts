import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ResourceRequestResolution } from '../../resources/ResourceRequestResolver.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import { IntentSlotRegistry } from '../execution/intentSlot.js';
import type { SessionDriverTaskResourceProgress } from '../runFrame.js';
import type { AssistantDiagnosticInfo } from '../projection/assistantProjectionBuilder.js';
import {
  normalizeProposalRouterResult,
  type ProposalRouterResult,
} from '../proposal/proposalRouter.js';
import { SessionDriverRepairRuntimeAccessor } from '../runFrame.js';
import type { ResourcePacketAppendResult } from './resourceOrchestrator.js';

export interface ResourceRequestProposalHandlerState {
  sessionId: string;
  runId: string;
  workspaceScopeKey: string;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  resourcePackets: ResourcePacket[];
  generatedArtifactEvidence: Map<string, unknown>;
  resourceRequestProgressByTask?: Map<string, SessionDriverTaskResourceProgress>;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  taskExecutionCursor?: unknown;
  currentTaskContext?: unknown;
  resourceRequestRepairAttempted: boolean;
  semanticDirectiveErrorSummary?: string;
}

export interface ResourceResolutionIssue {
  requestItemId: string;
  reason: string;
}

export interface GeneratedResourcePacketResult {
  packet?: ResourcePacket;
  remaining: ResourceRequestDraft;
}

export type ResourceRequestProposalHandlerResult = ProposalRouterResult;

export interface ResourceRequestProposalHandlerPorts<
  Input,
  State extends ResourceRequestProposalHandlerState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  generatedPacketForRequest(
    state: State,
    request: ResourceRequestDraft,
    packetId: string
  ): GeneratedResourcePacketResult;
  recordAndAppend(
    state: State,
    packet: ResourcePacket,
    eventIdPrefix: string
  ): Promise<ResourcePacketAppendResult>;
  resolveRecordAndAppend(
    state: State,
    manifest: ResourceManifest,
    eventIdPrefix: string
  ): Promise<ResourcePacketAppendResult>;
  resolveResourceRequest(
    manifest: ResourceManifest,
    request: ResourceRequestDraft,
    roots: ConversationResourceRoot[]
  ): ResourceRequestResolution;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | AssistantDiagnosticInfo,
    ts: string,
    id: string
  ): AgentEvent;
  internalFailureEvents(
    state: State,
    stage: string,
    code: string,
    message: string,
    id: string
  ): AgentEvent[];
  resourceResolutionDiagnostic(resolution: ResourceRequestResolution): AssistantDiagnosticInfo;
  completeResourceSemanticExchange(
    state: State,
    proposal: ProposalEnvelope,
    packets: readonly ResourcePacket[],
    issues?: readonly ResourceResolutionIssue[]
  ): Promise<void>;
  refreshTaskRuntimeState(state: State): void;
  acceptedPlanResourceResumeEvent(state: State, packet: ResourcePacket, ts: string, id: string): AgentEvent;
  tryCompleteResourceTask(
    input: Input,
    state: State,
    packet: ResourcePacket,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult | null>;
}

export interface ResourceRequestProposalHandlerInput<
  Input,
  State extends ResourceRequestProposalHandlerState,
> {
  input: Input;
  state: State;
  prompt: PromptEnvelope;
  proposal: ProposalEnvelope;
  lastResult: AgentSessionResult;
}

export class ResourceRequestProposalHandler<
  Input,
  State extends ResourceRequestProposalHandlerState,
> {
  private readonly intentSlots = new IntentSlotRegistry();

  constructor(private readonly ports: ResourceRequestProposalHandlerPorts<Input, State>) {}

  async handle(
    handlerInput: ResourceRequestProposalHandlerInput<Input, State>
  ): Promise<ResourceRequestProposalHandlerResult> {
    const { input, state, proposal } = handlerInput;
    let lastResult = handlerInput.lastResult;
    const taskId = this.intentSlots.currentTaskId(state.acceptedTaskPlan);
    const request = proposal.payload as ResourceRequestDraft;
    const requestSignature = resourceRequestSignature(request);
    const resolvedPackets: ResourcePacket[] = [];
    const progressByTask = state.resourceRequestProgressByTask ?? new Map<string, SessionDriverTaskResourceProgress>();
    state.resourceRequestProgressByTask = progressByTask;
    const taskProgress = taskId ? taskResourceProgress(progressByTask, taskId) : undefined;
    if (taskId && taskProgress?.signatures.includes(requestSignature)) {
      if (taskProgress.noProgressCount >= 1) {
        await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets, [{
          requestItemId: request.id,
          reason: 'session_resource_no_progress',
        }]);
        return {
          kind: 'return',
          result: await this.ports.append(state.sessionId, this.ports.internalFailureEvents(
            state,
            'resource_resolution',
            'session_resource_no_progress',
            `The provider repeated an already resolved resource request for task ${taskId} after one controlled redirect.`,
            this.ports.createId('resource-no-progress')
          )),
        };
      }
      taskProgress.noProgressCount += 1;
      state.semanticDirectiveErrorSummary = [
        'code=session_resource_no_progress',
        `taskId=${taskId}`,
        `resolvedPacketIds=${taskProgress.packetIds.join(' | ') || 'none'}`,
        'requiredAction=Use the already resolved ResourceEvidence and choose a non-resource current-task directive, or request a genuinely different target/range/search that adds evidence.',
      ].join('; ');
      await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets, [{
        requestItemId: request.id,
        reason: 'session_resource_no_progress',
      }]);
      return { kind: 'continue', lastResult };
    }
    const generated = this.ports.generatedPacketForRequest(
      state,
      request,
      this.ports.createId('generated-artifact-resource')
    );
    if (generated.packet) {
      resolvedPackets.push(generated.packet);
      lastResult = (await this.ports.recordAndAppend(
        state,
        generated.packet,
        'generated-artifact-resource-context'
      )).result;
      if (!generated.remaining.items.length) {
        if (taskProgress && generated.packet) recordTaskResourceProgress(taskProgress, requestSignature, generated.packet.id);
        await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets);
        return { kind: 'continue', lastResult };
      }
    }

    let subset = this.ports.resolveResourceRequest(
      state.manifest,
      generated.remaining,
      state.conversationRoots
    );
    if (
      !subset.manifest.entries.length
      && state.manifest.projectId
      && state.manifest.projectRootStatus === 'unbound'
    ) {
      await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets, [{
        requestItemId: request.id,
        reason: 'project_root_required',
      }]);
      return {
        kind: 'return',
        result: await this.ports.append(state.sessionId, [
          this.ports.finalDiagnosticEvent(
            state.sessionId,
            {
              code: 'project_root_required',
              fallback: 'This project is not bound to a directory. Bind a project directory before requesting files or workspace actions.',
              params: { projectId: state.manifest.projectId },
            },
            this.ports.now(),
            this.ports.createId('project-root-required')
          ),
        ]),
      };
    }
    const repairRuntime = new SessionDriverRepairRuntimeAccessor(state);
    if (!subset.manifest.entries.length && !repairRuntime.attempted('resourceRequestRepairAttempted')) {
      repairRuntime.markAttempted('resourceRequestRepairAttempted');
      state.semanticDirectiveErrorSummary = [
        'code=session_resource_directive_unresolved',
        `unresolved=${subset.unresolved.slice(0, 8).join(' | ') || 'none'}`,
        `ambiguous=${subset.ambiguous.slice(0, 8).join(' | ') || 'none'}`,
        `availableRootCount=${subset.availableRoots.length}`,
        'requiredAction=Call session.request_resources with one focused target under an available root, or choose another registered semantic directive.',
      ].join('; ');
      await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets, [
        ...subset.unresolved.map((reason, index) => ({ requestItemId: `unresolved-${index + 1}`, reason })),
        ...subset.ambiguous.map((reason, index) => ({ requestItemId: `ambiguous-${index + 1}`, reason })),
      ]);
      return { kind: 'continue', lastResult };
    }

    if (!subset.manifest.entries.length) {
      await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets, [
        ...subset.unresolved.map((reason, index) => ({ requestItemId: `unresolved-${index + 1}`, reason })),
        ...subset.ambiguous.map((reason, index) => ({ requestItemId: `ambiguous-${index + 1}`, reason })),
      ]);
      return {
        kind: 'return',
        result: await this.ports.append(state.sessionId, this.ports.internalFailureEvents(
          state,
          'resource_resolution',
          'resource_request_invalid',
          this.ports.resourceResolutionDiagnostic(subset).fallback,
          this.ports.createId('resource-invalid')
        )),
      };
    }

    const resourceAppend = await this.ports.resolveRecordAndAppend(
      state,
      subset.manifest,
      'resource-context'
    );
    const packet = resourceAppend.packet;
    resolvedPackets.push(packet);
    await this.ports.completeResourceSemanticExchange(state, proposal, resolvedPackets);
    if (taskProgress) recordTaskResourceProgress(taskProgress, requestSignature, packet.id);
    lastResult = resourceAppend.result;
    if (state.acceptedTaskPlan) {
      this.ports.refreshTaskRuntimeState(state);
      const resumeEvent = this.ports.acceptedPlanResourceResumeEvent(
        state,
        packet,
        this.ports.now(),
        this.ports.createId('accepted-plan-resource-resume')
      );
      lastResult = await this.ports.append(state.sessionId, [resumeEvent]) ?? lastResult;
      const readOnlyCompletion = await this.ports.tryCompleteResourceTask(
        input,
        state,
        packet,
        lastResult
      );
      if (readOnlyCompletion) {
        return normalizeProposalRouterResult(readOnlyCompletion);
      }
      return { kind: 'continue', lastResult };
    }
    return { kind: 'continue', lastResult };
  }
}

function taskResourceProgress(
  progressByTask: Map<string, SessionDriverTaskResourceProgress>,
  taskId: string
): SessionDriverTaskResourceProgress {
  const existing = progressByTask.get(taskId);
  if (existing) return existing;
  const created: SessionDriverTaskResourceProgress = {
    signatures: [],
    packetIds: [],
    noProgressCount: 0,
  };
  progressByTask.set(taskId, created);
  return created;
}

function recordTaskResourceProgress(
  progress: SessionDriverTaskResourceProgress,
  signature: string,
  packetId: string
): void {
  if (!progress.signatures.includes(signature)) progress.signatures.push(signature);
  if (!progress.packetIds.includes(packetId)) progress.packetIds.push(packetId);
  progress.signatures = progress.signatures.slice(-12);
  progress.packetIds = progress.packetIds.slice(-12);
  progress.noProgressCount = 0;
}

function resourceRequestSignature(request: ResourceRequestDraft): string {
  const items = request.items.map((item) => ({
    kind: item.kind,
    manifestEntryId: item.manifestEntryId,
    rootId: item.rootId,
    path: normalizePath(item.path),
    query: item.query?.trim(),
    include: [...(item.include ?? [])].sort(),
    contextLines: item.contextLines,
    maxResults: item.maxResults,
    offsetBytes: item.offsetBytes,
    limitBytes: item.limitBytes,
  }));
  return JSON.stringify(items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function normalizePath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized || undefined;
}
