import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type {
  ContextAssemblyRecord,
  PromptCachePlan,
  ProjectMemoryMode,
  SessionMemoryDocument,
} from '../../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type {
  AcceptedImplementationPlanContext,
  ImplementationBatchContext,
  TaskExecutionCursor,
  CurrentTaskContext,
} from '../execution/index.js';
import type {
  AcceptedPlanPromptFrame,
  TaskLedgerSnapshot,
} from '../../run-state/index.js';
import type { DriverRequestRef, KernelStateContractRef } from '../types.js';
import type { InteractionOverlayContext, SessionTurnPhase } from './interactionOverlayCodec.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';

export interface RunLifecycleInput {
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
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface RunLifecycleState {
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
  generatedArtifactEvidence: Map<string, unknown>;
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  providerTurnFrame?: DriverProviderTurnFrame;
  implementationBatch: ImplementationBatchContext;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  resourceRequestRepairAttempted: boolean;
  actionBundleAdmissionRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
  acceptedPlanScopeRepairAttempted: boolean;
  terminalGuidanceRevisionAttempted: boolean;
  nativeToolReadLedger: Map<string, unknown>;
  nativeToolDuplicateRepairAttempted: boolean;
  interactionOverlay?: InteractionOverlayContext;
}

export interface RunLifecyclePipelinePorts<State extends RunLifecycleState> {
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult>;
  userMessageEvent(input: {
    sessionId: string;
    content: string;
    attachments: AgentContextAttachment[];
  }): AgentEvent;
  kernelRunAttachments(input: RunLifecycleInput): AgentContextAttachment[];
  buildManifest(input: RunLifecycleInput, manifestId: string): {
    manifest: ResourceManifest;
    conversationRoots: ConversationResourceRoot[];
  };
  buildImplementationBatch(events: AgentEvent[]): ImplementationBatchContext;
  buildMemoryDocument(events: AgentEvent[], options: { projectMemoryMode?: ProjectMemoryMode }): SessionMemoryDocument;
  recentResourcePackets(events: AgentEvent[]): ResourcePacket[];
  generatedArtifactEvidenceFromPackets(packets: ResourcePacket[]): Map<string, unknown>;
  initialTaskRuntime(input: {
    acceptedPlan?: AcceptedImplementationPlanContext;
    resourcePackets: ResourcePacket[];
    lastSavepointId?: string;
  }): {
    taskExecutionCursor?: TaskExecutionCursor;
    currentTaskContext?: CurrentTaskContext;
    taskLedger?: TaskLedgerSnapshot;
    acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  };
  lastSavepointId(events: AgentEvent[]): string | undefined;
  implementationBatchHints(
    context: ImplementationBatchContext,
    acceptedPlan?: AcceptedImplementationPlanContext
  ): string[];
  resolveInitialResources(state: State): Promise<AgentSessionResult>;
}

export interface RunLifecycleResult<State extends RunLifecycleState> {
  state: State;
  lastResult: AgentSessionResult;
}

export class RunLifecyclePipeline<State extends RunLifecycleState> {
  constructor(private readonly ports: RunLifecyclePipelinePorts<State>) {}

  async initialize(input: RunLifecycleInput): Promise<RunLifecycleResult<State>> {
    const sessionId = input.sessionId;
    let lastResult = input.appendUserMessage === false
      ? await this.ports.append(sessionId, [])
      : await this.ports.append(sessionId, [
        this.ports.userMessageEvent({
          sessionId,
          content: input.content,
          attachments: input.attachments ?? [],
        }),
      ]);

    const kernelAttachments = this.ports.kernelRunAttachments(input);
    const runReply = await this.ports.kernel({
      command: {
        kind: 'runCreate',
        requestId: this.ports.createId('run-create'),
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
    lastResult = await this.ports.appendProjectedKernelEvents(sessionId, runReply);

    const events = input.existingEvents ?? [];
    const runId = firstString(runReply.events, 'runId') ?? this.ports.createId('run');
    const manifestBuild = this.ports.buildManifest(input, this.ports.createId('resource-manifest'));
    const acceptedImplementationPlan = input.acceptedImplementationPlan;
    const implementationBatch = this.ports.buildImplementationBatch(events);
    if (acceptedImplementationPlan) {
      implementationBatch.batchIndex = acceptedImplementationPlan.batchIndex;
    }
    const restoredResourcePackets = input.resumeResourcePackets
      ? this.ports.recentResourcePackets(events)
      : [];
    const initialTaskRuntime = this.ports.initialTaskRuntime({
      acceptedPlan: acceptedImplementationPlan,
      resourcePackets: restoredResourcePackets,
      lastSavepointId: this.ports.lastSavepointId(events),
    });
    const state = {
      sessionId,
      runId,
      userRequest: input.content,
      phase: 'context_reading',
      workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
      stateContract: findStateContract(runReply.events),
      driverRequest: findDriverRequest(runReply.events),
      manifest: manifestBuild.manifest,
      conversationRoots: manifestBuild.conversationRoots,
      initialContext: {
        id: this.ports.createId('initial-context'),
        workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
        manifest: manifestBuild.manifest,
      },
      resourcePackets: [...restoredResourcePackets],
      generatedArtifactEvidence: this.ports.generatedArtifactEvidenceFromPackets(restoredResourcePackets),
      memoryDocument: this.ports.buildMemoryDocument(events, {
        projectMemoryMode: input.projectMemoryMode,
      }),
      memoryHints: this.ports.implementationBatchHints(implementationBatch, acceptedImplementationPlan),
      taskExecutionCursor: initialTaskRuntime.taskExecutionCursor,
      currentTaskContext: initialTaskRuntime.currentTaskContext,
      taskLedger: initialTaskRuntime.taskLedger,
      acceptedPlanPromptFrame: initialTaskRuntime.acceptedPlanPromptFrame,
      implementationBatch,
      acceptedImplementationPlan,
      resourceRequestRepairAttempted: false,
      actionBundleAdmissionRepairAttempted: false,
      planReviewRepairAttempted: false,
      acceptedPlanScopeRepairAttempted: false,
      terminalGuidanceRevisionAttempted: false,
      nativeToolReadLedger: new Map<string, unknown>(),
      nativeToolDuplicateRepairAttempted: false,
      interactionOverlay: input.interactionOverlay,
    } as State;

    if (state.manifest.entries.length > 0 && !input.resumeResourcePackets) {
      lastResult = await this.ports.resolveInitialResources(state);
    }

    return { state, lastResult };
  }
}

function findStateContract(events: unknown[] | undefined): KernelStateContractRef | undefined {
  for (const event of events ?? []) {
    const record = objectRecord(event);
    const contract = objectRecord(record?.stateContract);
    if (contract) return contract as unknown as KernelStateContractRef;
  }
  return undefined;
}

function findDriverRequest(events: unknown[] | undefined): DriverRequestRef | undefined {
  for (const event of events ?? []) {
    const record = objectRecord(event);
    const driverRequest = objectRecord(record?.driverRequest);
    if (driverRequest) return driverRequest as unknown as DriverRequestRef;
  }
  return undefined;
}

function firstString(events: unknown[] | undefined, key: string): string | undefined {
  for (const event of events ?? []) {
    const record = objectRecord(event);
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
