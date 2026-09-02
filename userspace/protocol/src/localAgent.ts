export const LOCAL_AGENT_PROTOCOL_VERSION = 'deepcode.local-agent' as const;
export const CONVERSATION_COMMAND_VERSION = 'deepcode.command.v3' as const;
export const COMMAND_REPLY_VERSION = 'deepcode.command-reply.v3' as const;
export const SESSION_EVENT_VERSION = 'deepcode.session-event.v4' as const;
export const SESSION_PROJECTION_VERSION = 'deepcode.session-projection.v4' as const;
export const PROVIDER_EVENT_VERSION = 'deepcode.provider-event' as const;
export const KERNEL_REQUEST_VERSION = 'deepcode.kernel-request' as const;
export const KERNEL_REPLY_VERSION = 'deepcode.kernel-reply' as const;
export const SESSION_CONTROL_INTERACTION_REQUEST = 'interaction.request' as const;
export const SESSION_CONTROL_PLAN_PUBLISH = 'plan.publish' as const;

export type JsonObject = Record<string, unknown>;

export interface LocalAgentError {
  code: string;
  message: string;
}

/** Ordinary catalog and projection views deliberately omit canonicalRoot. */
export interface WorkspaceBindingDisplay {
  workspaceId: string;
  displayName: string;
}

/** Only the explicit workspace picker/management surface may consume this view. */
export interface WorkspaceManagementRecord extends WorkspaceBindingDisplay {
  canonicalRoot: string;
  createdAt: string;
}

export interface ConversationProject {
  id: string;
  title: string;
  workspaceBindings: WorkspaceBindingDisplay[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSessionSummary {
  id: string;
  title: string;
  projectId?: string;
  profileId?: string;
  workspaceBindings: WorkspaceBindingDisplay[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationCatalog {
  projects: ConversationProject[];
  sessions: ConversationSessionSummary[];
}

export interface ConversationCatalogManagement extends ConversationCatalog {
  workspaces: WorkspaceManagementRecord[];
}

/**
 * Message-level reference to a Host-resolved filesystem object. Host canonical paths remain
 * private; Provider requests receive the corresponding logical workspace handle and path.
 */
export type FilesystemReference = {
  referenceId: string;
  workspaceId: string;
  logicalPath: string;
  displayName: string;
} & (
  | {
      kind: 'file';
      mediaType: string;
      byteLength: number;
    }
  | {
      kind: 'directory';
      mediaType?: never;
      byteLength?: never;
    }
);

export type PluginUri = `plugin://${string}@${string}`;

export interface PluginCatalogItem {
  uri: PluginUri;
  displayName: string;
  shortDescription: string;
  iconRef?: string;
  activationMediaTypes: string[];
  enabled: true;
  available: true;
}

export interface PluginCatalogProjection {
  revision: string;
  plugins: PluginCatalogItem[];
}

export interface PluginSelectionInput {
  selectionId: string;
  uri: PluginUri;
  label: string;
}

export interface SelectedPluginSnapshot {
  catalogRevision: string;
  plugins: Array<{
    uri: PluginUri;
    pluginArtifactRef: string;
    pluginInstanceRef: string;
    extensionGenerationRef: string;
    capabilityRefs: string[];
  }>;
}

export type PlanOperationName =
  | 'fs.write'
  | 'fs.edit'
  | 'fs.delete'
  | 'bash';

export type PlanOperation =
  | {
      workspaceId: string;
      operation: Exclude<PlanOperationName, 'fs.delete' | 'bash'>;
      target: string;
    }
  | {
      workspaceId: string;
      operation: 'fs.delete';
      target: string;
      targetKind: 'file' | 'directoryTree';
    }
  | {
      workspaceId: string;
      operation: 'bash';
      command: string;
      workspaceMode: 'write';
      executionScope: 'workspace' | 'host';
      terminal?: { stdin: string };
    };

export interface ExecutionPlanStep {
  stepId: string;
  title: string;
  details: string;
  verification?: string[];
}

export interface ExecutionPlan {
  planId: string;
  revision: number;
  title: string;
  summary: string;
  steps: ExecutionPlanStep[];
  mutationManifest: PlanOperation[];
}

export type PlanResponse =
  | { kind: 'confirm' }
  | { kind: 'requestRevision'; text: string }
  | { kind: 'cancel' };

export type MessageFeedback = 'up' | 'down';

export type ConversationCommand =
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'session.directory-index.attach';
      commandId: string;
      sessionId: string;
      workspaceBinding: WorkspaceBindingDisplay;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'session.directory-index.detach';
      commandId: string;
      sessionId: string;
      workspaceId: string;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'message.submit';
      commandId: string;
      sessionId: string;
      text: string;
      filesystemReferences?: FilesystemReference[];
      profileId?: string;
      pluginCatalogRevision?: string;
      pluginSelections?: PluginSelectionInput[];
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'context.focus';
      commandId: string;
      sessionId: string;
      task: string;
      filesystemReferences?: FilesystemReference[];
      profileId?: string;
      pluginCatalogRevision?: string;
      pluginSelections?: PluginSelectionInput[];
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'message.feedback.set';
      commandId: string;
      sessionId: string;
      messageId: string;
      feedback: MessageFeedback | null;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'run.cancel';
      commandId: string;
      sessionId: string;
      runId: string;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'interaction.respond';
      commandId: string;
      sessionId: string;
      runId: string;
      interactionId: string;
      response: string;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'approval.respond';
      commandId: string;
      sessionId: string;
      runId: string;
      callId: string;
      approvalId: string;
      decision: 'allow' | 'deny';
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'plan.respond';
      commandId: string;
      sessionId: string;
      runId: string;
      planId: string;
      revision: number;
      response: PlanResponse;
    };

export interface CommandReply {
  schemaVersion: typeof COMMAND_REPLY_VERSION;
  commandId: string;
  sessionId: string;
  status: 'accepted' | 'replayed' | 'rejected';
  revision: number;
  error?: LocalAgentError;
}

interface SessionEventBase {
  schemaVersion: typeof SESSION_EVENT_VERSION;
  eventId: string;
  sessionId: string;
  sequence: number;
  occurredAt: string;
}

export type RunSettlement =
  | { outcome: 'completed'; finalMessageId: string }
  | { outcome: 'failed'; error: LocalAgentError }
  | { outcome: 'cancelled' }
  | { outcome: 'indeterminate'; error: LocalAgentError };

export type ProviderTurnSettlement = {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  providerRuntimeRef: string;
} & (
  | {
      outcome: 'completed';
      orderedCallIds: string[];
      reasoningContent?: string;
      reasoningSignature?: string;
    }
  | {
      outcome: 'failed' | 'indeterminate';
      error: LocalAgentError;
    }
);

export interface RunRuntimeReleaseReceipt {
  runRuntimeSnapshotRef: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  providerRuntimeRef: string;
  pluginInstanceRefs: string[];
  alreadyReleased: boolean;
}

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ModelInteractionRequest {
  kind: 'question' | 'confirmation';
  prompt: string;
  options?: InteractionOption[];
  allowFreeform: boolean;
}

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
}

export interface ContextUsageProjection extends ProviderTokenUsage {
  providerRequestId: string;
  providerRuntimeRef: string;
  runId: string;
  sequence: number;
  updatedAt: string;
}

export interface TokenUsageProjection {
  providerCallCount: number;
  reportedCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheMissInputTokens: number;
  cacheAvailable: boolean;
  cacheComplete: boolean;
  cacheHitRatio: number | null;
}

export interface TokenUsageRoundProjection extends TokenUsageProjection {
  runId: string;
  inputMessageId: string;
  title: string;
  sequence: number;
  startedAt: string;
  completedAt?: string;
  outcome?: RunSettlement['outcome'];
}

export type ContextCompositionPartitionKind =
  | 'instructions'
  | 'workspaceBindings'
  | 'sessionControls'
  | 'journalMessages'
  | 'contextProviders'
  | 'filesystemReferences'
  | 'tools';

export interface ContextCompositionItem {
  itemId: string;
  label: string;
}

export interface ContextCompositionTool extends ContextCompositionItem {
  canonicalName: string;
  wireName: string;
  origin: 'coreBuiltin' | 'extension' | 'sessionControl';
  availability: 'callable' | 'blocked';
  pluginUri?: PluginUri;
}

export type ContextCompositionMessageKind = Exclude<
  ContextCompositionPartitionKind,
  'filesystemReferences' | 'tools'
>;

export type ContextCompositionMessageBlock =
  | {
      blockIndex: number;
      kind: 'text' | 'reasoning';
    }
  | {
      blockIndex: number;
      kind: 'toolCall';
      callId: string;
      toolName: string;
    }
  | {
      blockIndex: number;
      kind: 'toolResult';
      resultForCallId: string;
    };

export interface ContextCompositionMessage {
  messageIndex: number;
  contributionId: string;
  contributionKind: ContextCompositionMessageKind;
  label: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  blocks: ContextCompositionMessageBlock[];
  filesystemReferences: ContextCompositionItem[];
}

export interface ContextCompositionPartitionReceipt {
  kind: ContextCompositionPartitionKind;
  itemCount: number;
  requestShapeUnits: number;
}

export interface ContextCompositionPartitionProjection
  extends ContextCompositionPartitionReceipt {
  estimatedInputTokens?: number;
  tokenSource?: 'sessionEstimated';
}

export type ProviderResponseConstraint = 'normal' | 'toolRequired' | 'answerOnly';

export interface ContextCompositionReceipt {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  responseConstraint: ProviderResponseConstraint;
  stableCoreHash: string;
  baseToolSchemaHash: string;
  selectedPluginSnapshotHash: string;
  dynamicInstructionBytes: number;
  messages: ContextCompositionMessage[];
  workspaceBindings: ContextCompositionItem[];
  tools: ContextCompositionTool[];
  partitions: ContextCompositionPartitionReceipt[];
}

interface ContextCompositionProjectionBase {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  responseConstraint: ProviderResponseConstraint;
  runId: string;
  sequence: number;
  createdAt: string;
}

export interface ContextCompositionProjection extends ContextCompositionProjectionBase {
  stableCoreHash: string;
  baseToolSchemaHash: string;
  selectedPluginSnapshotHash: string;
  dynamicInstructionBytes: number;
  messages: ContextCompositionMessage[];
  workspaceBindings: ContextCompositionItem[];
  tools: ContextCompositionTool[];
  partitions: ContextCompositionPartitionProjection[];
}

export type TodoStatus = 'pending' | 'inProgress' | 'completed';

export interface TodoItem {
  todoId: string;
  sourceStepId: string;
  label: string;
  status: TodoStatus;
}

export interface TodoListProjection {
  sourcePlanId: string;
  sourcePlanRevision: number;
  items: TodoItem[];
  sequence: number;
  updatedAt: string;
}

export interface TodoProgressUpdate {
  todoId: string;
  status: TodoStatus;
}

export type ContextCompactionTrigger = 'pressure' | 'userFocus';

export type ContextCompactionRequestPayload = {
  compactionId: string;
  providerRequestId: string;
  coveredThroughSequence: number;
} & (
  | { trigger: 'pressure' }
  | { trigger: 'userFocus'; focus: string; commandId: string }
);

export interface ContextCompactedPayload {
  compactionId: string;
  providerRequestId: string;
  trigger: ContextCompactionTrigger;
  coveredThroughSequence: number;
  summary: string;
}

export interface EffectPreview {
  summary: string;
  effects: EffectKind[];
  logicalTargets: string[];
}

export type SessionEvent =
  | (SessionEventBase & {
      type: 'session.created';
      payload: {
        displayTitle: string;
        workspaceBindings: WorkspaceBindingDisplay[];
        profileId?: string;
      };
    })
  | (SessionEventBase & {
      type: 'session.directory-index.attached';
      payload: { workspaceBinding: WorkspaceBindingDisplay; commandId: string };
    })
  | (SessionEventBase & {
      type: 'session.directory-index.detached';
      payload: { workspaceId: string; commandId: string };
    })
  | (SessionEventBase & {
      type: 'input.accepted';
      payload: {
        commandId: string;
        messageId: string;
        text: string;
        pluginSelections?: PluginSelectionInput[];
      };
    })
  | (SessionEventBase & {
      type: 'run.started';
      runId: string;
      payload: {
        inputMessageId: string;
        workspaceBindings: WorkspaceBindingDisplay[];
        runtimeSnapshot: RunRuntimeSnapshot;
      };
    })
  | (SessionEventBase & {
      type: 'message.committed';
      runId: string;
      callId?: string;
      payload: {
        messageId: string;
        role: 'assistant';
        content: string;
        filesystemReferences?: FilesystemReference[];
        pluginSelections?: PluginSelectionInput[];
        providerRequestId: string;
      };
    })
  | (SessionEventBase & {
      type: 'message.committed';
      runId?: string;
      callId?: string;
      payload: {
        messageId: string;
        role: 'user' | 'tool' | 'system';
        content: string;
        filesystemReferences?: FilesystemReference[];
        pluginSelections?: PluginSelectionInput[];
      };
    })
  | (SessionEventBase & {
      type: 'message.feedback.updated';
      payload: {
        commandId: string;
        messageId: string;
        feedback: MessageFeedback | null;
      };
    })
  | (SessionEventBase & {
      type: 'narrative.committed';
      runId: string;
      payload: { narrativeId: string; content: string; providerRequestId: string };
    })
  | (SessionEventBase & {
      type: 'interaction.requested';
      runId: string;
      callId: string;
      payload: ModelInteractionRequest & { interactionId: string; providerCallId: string };
    })
  | (SessionEventBase & {
      type: 'interaction.resolved';
      runId: string;
      payload: { interactionId: string; commandId: string; response: string };
    })
  | (SessionEventBase & {
      type: 'plan.published';
      runId: string;
      callId: string;
      payload: ExecutionPlan & { providerCallId: string };
    })
  | (SessionEventBase & {
      type: 'plan.confirmed';
      runId: string;
      callId: string;
      payload: {
        planId: string;
        revision: number;
        commandId: string;
        decisionId: string;
        authorities: PlanAuthority[];
      };
    })
  | (SessionEventBase & {
      type: 'plan.revision.requested';
      runId: string;
      callId: string;
      payload: { planId: string; revision: number; commandId: string; text: string };
    })
  | (SessionEventBase & {
      type: 'plan.superseded';
      runId: string;
      payload: {
        planId: string;
        revision: number;
        supersededByPlanId: string;
        supersededByRevision: number;
      };
    })
  | (SessionEventBase & {
      type: 'plan.cancelled';
      runId: string;
      callId: string;
      payload: { planId: string; revision: number; commandId: string };
    })
  | (SessionEventBase & {
      type: 'plan.completed';
      runId: string;
      payload: { planId: string; revision: number };
    })
  | (SessionEventBase & {
      type: 'plan.invalidated';
      runId: string;
      payload: { planId: string; revision: number; reason: string; sourceFactRef: string };
    })
  | (SessionEventBase & {
      type: 'todo.seeded' | 'todo.reconciled';
      runId: string;
      payload: {
        sourcePlanId: string;
        sourcePlanRevision: number;
        items: TodoItem[];
      };
    })
  | (SessionEventBase & {
      type: 'todo.progressed';
      runId: string;
      payload: {
        sourcePlanId: string;
        sourcePlanRevision: number;
        sourceFactRef: string;
        updates: TodoProgressUpdate[];
      };
    })
  | (SessionEventBase & {
      type: 'tool.requested';
      runId: string;
      callId: string;
      payload: {
        providerCallId: string;
        attemptId: string;
        toolName: string;
        input: JsonObject;
      };
    })
  | (SessionEventBase & {
      type: 'approval.requested';
      runId: string;
      callId: string;
      payload: { approvalId: string; preview: EffectPreview };
    })
  | (SessionEventBase & {
      type: 'approval.resolved';
      runId: string;
      callId: string;
      payload: {
        approvalId: string;
        commandId: string;
        decision: 'allow' | 'deny';
        authorityId: string;
      };
    })
  | (SessionEventBase & {
      type: 'tool.completed';
      runId: string;
      callId: string;
      payload: { record: ToolExecutionRecord };
    })
  | (SessionEventBase & {
      type: 'session.control.rejected';
      runId: string;
      callId: string;
      payload: {
        providerCallId: string;
        toolName: string;
        input: JsonObject;
        error: LocalAgentError;
      };
    })
  | (SessionEventBase & {
      type: 'context.compaction.requested';
      runId: string;
      payload: ContextCompactionRequestPayload;
    })
  | (SessionEventBase & {
      type: 'context.compacted';
      runId: string;
      payload: ContextCompactedPayload;
    })
  | (SessionEventBase & {
      type: 'context.composed';
      runId: string;
      payload: ContextCompositionReceipt;
    })
  | (SessionEventBase & {
      type: 'provider.turn.settled';
      runId: string;
      payload: ProviderTurnSettlement;
    })
  | (SessionEventBase & {
      type: 'context.updated';
      runId: string;
      payload: ProviderTokenUsage & { providerRequestId: string; providerRuntimeRef: string };
    })
  | (SessionEventBase & {
      type: 'run.waiting';
      runId: string;
      payload: { reason: 'approval' | 'userInput' | 'plan'; detail?: string };
    })
  | (SessionEventBase & {
      type: 'run.finishing';
      runId: string;
      payload: RunSettlement;
    })
  | (SessionEventBase & {
      type: 'run.runtime.released';
      runId: string;
      payload: RunRuntimeReleaseReceipt;
    })
  | (SessionEventBase & {
      type: 'run.runtime.release_failed';
      runId: string;
      payload: {
        runRuntimeSnapshotRef: string;
        extensionGenerationRef: string;
        kernelCatalogSnapshotRef: string;
        providerRuntimeRef: string;
        error: LocalAgentError;
      };
    })
  | (SessionEventBase & {
      type: 'run.settled';
      runId: string;
      payload: RunSettlement;
    });

export type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, 'schemaVersion' | 'eventId' | 'sequence' | 'occurredAt'>
    : never
  : never;

interface ProjectionMessageBase {
  messageId: string;
  content: string;
  filesystemReferences: FilesystemReference[];
  pluginSelections: PluginSelectionInput[];
  feedback: MessageFeedback | null;
  sequence: number;
  createdAt: string;
}

export type ProjectionMessage = ProjectionMessageBase & (
  | {
      role: 'assistant';
      runId: string;
      providerRequestId: string;
    }
  | {
      role: 'user' | 'tool' | 'system';
      runId?: string;
      providerRequestId?: never;
    }
);

export interface NarrativeProjection {
  narrativeId: string;
  runId: string;
  providerRequestId: string;
  content: string;
  sequence: number;
  createdAt: string;
}

export type SessionTimelineItem =
  | {
      kind: 'message';
      timelineId: string;
      sequence: number;
      messageId: string;
    }
  | {
      kind: 'narrative';
      timelineId: string;
      sequence: number;
      providerRequestId: string;
      narrativeId: string;
    }
  | {
      kind: 'plan';
      timelineId: string;
      sequence: number;
      providerRequestId: string;
      planId: string;
      revision: number;
    }
  | {
      kind: 'toolGroup';
      timelineId: string;
      sequence: number;
      providerRequestId: string;
      activityIds: string[];
    };

export interface InteractionProjection extends ModelInteractionRequest {
  interactionId: string;
  runId: string;
  callId: string;
  sequence: number;
  createdAt: string;
}

export interface ApprovalProjection {
  approvalId: string;
  runId: string;
  callId: string;
  preview: EffectPreview;
  sequence: number;
  createdAt: string;
}

/**
 * Session-owned, non-durable text for the one Provider turn currently streaming.
 * It is replaced by a canonical narrative or assistant message when the typed turn ends.
 */
export interface AssistantDraftProjection {
  runId: string;
  turnId: string;
  content: string;
}

export type PlanProjectionStatus =
  | 'published'
  | 'revisionRequested'
  | 'confirmed'
  | 'superseded'
  | 'cancelled'
  | 'completed'
  | 'invalidated';

export interface PlanProjection extends ExecutionPlan {
  runId: string;
  callId: string;
  status: PlanProjectionStatus;
  decisionId?: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface PendingPlanProjection extends PlanProjection {
  status: 'published';
  responseMode: 'confirmReviseOrCancel';
}

export const RUN_PROJECTION_STATUSES = [
  'running',
  'waiting',
  'releasing',
  'releaseFailed',
  'completed',
  'failed',
  'cancelled',
  'indeterminate',
] as const;

export type RunProjectionStatus = typeof RUN_PROJECTION_STATUSES[number];

export interface RunProjection {
  runId: string;
  profileId: string;
  waitingReason?: 'approval' | 'userInput' | 'plan';
  /** Immutable effective directory set captured by run.started. */
  workspaceBindings: WorkspaceBindingDisplay[];
  status: RunProjectionStatus;
}

export interface ActivityProjection {
  activityId: string;
  kind: 'run' | 'tool' | 'approval' | 'plan' | 'interaction';
  status:
    | 'active'
    | 'requested'
    | 'waiting'
    | 'completed'
    | 'denied'
    | 'failed'
    | 'cancelled'
    | 'indeterminate';
  label: string;
  runId: string;
  callId?: string;
  sequence: number;
  tool?: ToolActivityProjection;
}

export interface ActivityResourceProjection {
  kind: 'workspacePath' | 'url' | 'logicalTarget';
  label: string;
  workspaceId?: string;
  logicalPath?: string;
  uri?: string;
}

export interface ToolActivityProjection {
  operation: string;
  resources: ActivityResourceProjection[];
  shell?: ShellActivityProjection;
}

export interface ShellActivityProjection {
  command: string;
  cwd: string;
  executionScope: 'workspace' | 'host';
  terminal: boolean;
  result?: ShellActivityResultProjection;
}

export interface ShellActivityResultProjection {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  timedOut: boolean;
  truncated: boolean;
  capturedBytes: number;
  durationMs: number;
  environment: ShellExecutionEnvironmentProjection;
}

export interface ShellExecutionEnvironmentProjection {
  shell: string;
  interactive: boolean;
  executionScope: 'workspace' | 'host';
  terminal: boolean;
  pathSource: 'hostPlusStandardDeveloperPaths';
  writeScope: 'kernelTemporaryOnly' | 'workspaceAndKernelTemporary' | 'hostUser';
  homeWritable: boolean;
  networkAccess: boolean;
}

export interface ArtifactProjection {
  artifactId: string;
  label: string;
  workspaceId?: string;
  logicalPath?: string;
  uri?: string;
}

export interface SessionDisplayProjection {
  creationTitle: string;
}

export interface SessionProjection {
  schemaVersion: typeof SESSION_PROJECTION_VERSION;
  sessionId: string;
  revision: number;
  display: SessionDisplayProjection;
  /** Current effective set: immutable creation bindings plus attached directory indexes. */
  workspaceBindings: WorkspaceBindingDisplay[];
  /** Session-private directory indexes that the user may detach for future runs. */
  sessionDirectoryIndexes: WorkspaceBindingDisplay[];
  messages: ProjectionMessage[];
  narratives: NarrativeProjection[];
  /** Session-owned semantic transcript order. Shells render this list without re-sorting it. */
  timeline: SessionTimelineItem[];
  assistantDraft: AssistantDraftProjection | null;
  pendingInteraction: InteractionProjection | null;
  pendingApproval: ApprovalProjection | null;
  plans: PlanProjection[];
  activePlanRef: { planId: string; revision: number } | null;
  pendingPlan: PendingPlanProjection | null;
  todoList: TodoListProjection | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: ContextCompositionProjection[];
  tokenUsage: TokenUsageProjection;
  tokenUsageHistory: TokenUsageRoundProjection[];
  run: RunProjection | null;
  activities: ActivityProjection[];
  artifacts: ArtifactProjection[];
  terminalError: LocalAgentError | null;
}

export interface ConversationPort {
  submit(command: ConversationCommand): Promise<CommandReply>;
  snapshot(sessionId: string): Promise<SessionProjection>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoningContent?: string;
  reasoningSignature?: string;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolCall {
  callId: string;
  name: string;
  input: JsonObject;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ProviderRuntimeSnapshot {
  providerRuntimeRef: string;
  profileId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ProviderRequest {
  protocolVersion: typeof LOCAL_AGENT_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  runId: string;
  providerRuntimeRef: string;
  profileId: string;
  purpose: 'agent' | 'contextCompaction';
  responseConstraint: ProviderResponseConstraint;
  maxOutputTokens: number;
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  messages: readonly ModelMessage[];
  tools: readonly ProviderToolDefinition[];
}

export type ProviderEvent =
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'text.delta';
      data: { text: string };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'assistant.message';
      data: {
        messageId: string;
        content: string;
        reasoningContent?: string;
        reasoningSignature?: string;
      };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'tool.call';
      data: { callId: string; name: string; input: JsonObject };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'completed';
      data: JsonObject;
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'failed';
      data: LocalAgentError;
    };

export interface ProviderPort {
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export type EffectKind =
  | 'workspaceRead'
  | 'workspaceMutation'
  | 'process'
  | 'network'
  | 'external';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  possibleEffects: EffectKind[];
  availability: 'callable' | 'blocked';
}

export interface PreparedToolDescriptor extends ToolDescriptor {
  toolBindingRef: string;
  origin: 'coreBuiltin' | 'extension';
  pluginUri?: PluginUri;
}

export interface ToolPromptContribution {
  contributionRef: string;
  canonicalToolName: string;
  promptSnippet?: string;
  usageGuidelines: string[];
}

export type ToolPromptProviderSnapshot = {
  providerRef: string;
  contributions: ToolPromptContribution[];
} & (
  | {
      origin: 'coreBuiltin';
      pluginUri?: never;
    }
  | {
      origin: 'extension';
      pluginUri: PluginUri;
    }
);

export type PreparedToolPromptContribution = ToolPromptContribution & {
  preparedToolBindingRef: string;
} & (
  | {
      origin: 'coreBuiltin';
      pluginUri?: never;
    }
  | {
      origin: 'extension';
      pluginUri: PluginUri;
    }
);

export interface ProviderToolAlias {
  canonicalName: string;
  wireName: string;
}

export interface RunRuntimeSnapshot {
  runRuntimeSnapshotRef: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  provider: ProviderRuntimeSnapshot;
  instructions: { id: string; text: string }[];
  tools: PreparedToolDescriptor[];
  toolPromptContributions: PreparedToolPromptContribution[];
  providerToolAliases: ProviderToolAlias[];
  selectedPlugins: SelectedPluginSnapshot;
}

export interface PrepareRunRuntimeRequest {
  sessionId: string;
  runId: string;
  profileId?: string;
  pluginCatalogRevision?: string;
  pluginSelections?: PluginSelectionInput[];
}

export interface PreparedRunRuntime {
  runtimeSnapshot: RunRuntimeSnapshot;
}

export interface ReleaseRunRuntimeRequest {
  sessionId: string;
  runId: string;
  kernelCatalogSnapshotRef: string;
}

export interface ReleaseRunRuntimeResult {
  kernelCatalogSnapshotRef: string;
  alreadyReleased: boolean;
}

/** Host composition root owns atomic run preparation across Provider and Kernel generations. */
export interface RunPreparationPort {
  prepare(request: PrepareRunRuntimeRequest): Promise<PreparedRunRuntime>;
  release(request: ReleaseRunRuntimeRequest): Promise<ReleaseRunRuntimeResult>;
}

export interface PlanAuthority {
  authorityId: string;
  planId: string;
  revision: number;
  decisionId: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  coveredOperations: PlanOperation[];
}

export interface PreparedEffectProjection {
  callId: string;
  attemptId: string;
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  contributionRef: string;
  providerRef: string;
  origin: 'coreBuiltin' | 'extension';
  pluginInstanceRef?: string;
  toolName: string;
  workspaceId?: string;
  processWorkspaceMode?: 'read' | 'write';
  processExecutionScope?: 'workspace' | 'host';
  operation: string;
  logicalTargets: string[];
  canonicalInvocation: {
    toolName: string;
    arguments: JsonObject;
  };
}

export interface ToolExecutionRequest {
  schemaVersion: typeof KERNEL_REQUEST_VERSION;
  type: 'tool.execute';
  requestId: string;
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  callId: string;
  attemptId: string;
  toolName: string;
  input: JsonObject;
  workspaceBindings: string[];
  planAuthorities?: PlanAuthority[];
  nonWorkspaceAuthority?: {
    authorityId: string;
    decision: 'allow' | 'deny';
  };
}

export type WorkspaceAuthorityDecision =
  | { decision: 'allow'; source: 'workspaceBinding'; workspaceId: string }
  | {
      decision: 'allow';
      source: 'plan';
      workspaceId: string;
      authorityId: string;
      planId: string;
      revision: number;
      decisionId: string;
    }
  | {
      decision: 'allow';
      source: 'userSetting';
      authorityId: string;
      workspaceId: string;
    };

export type NonWorkspaceAuthorityDecision =
  | { decision: 'allow'; source: 'user' | 'userSetting'; authorityId: string }
  | { decision: 'deny'; source: 'user'; authorityId: string }
  | { decision: 'deny'; source: 'kernel' | 'userSetting'; reason: string };

export type AuthorityDecision =
  | WorkspaceAuthorityDecision
  | NonWorkspaceAuthorityDecision
  | {
      decision: 'allow' | 'deny';
      source: 'composite';
      workspaceAuthority: WorkspaceAuthorityDecision;
      externalAuthority: NonWorkspaceAuthorityDecision;
    };

interface ToolExecutionRecordBase {
  recordId: string;
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  callId: string;
  attemptId: string;
  toolName: string;
  input: JsonObject;
  preparedEffect: PreparedEffectProjection;
  authority: AuthorityDecision;
  startedAt: string;
  completedAt: string;
}

export type ToolExecutionRecord =
  | (ToolExecutionRecordBase & { outcome: 'completed'; output: unknown })
  | (ToolExecutionRecordBase & { outcome: 'denied'; error?: LocalAgentError })
  | (ToolExecutionRecordBase & { outcome: 'failed'; output?: unknown; error: LocalAgentError })
  | (ToolExecutionRecordBase & { outcome: 'cancelled' })
  | (ToolExecutionRecordBase & { outcome: 'indeterminate'; error: LocalAgentError });

export type ToolExecutionReply =
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.execution';
      requestId: string;
      callId: string;
      status: 'approvalRequired';
      approvalId: string;
      preview: EffectPreview;
    }
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.execution';
      requestId: string;
      callId: string;
      status: ToolExecutionRecord['outcome'];
      record: ToolExecutionRecord;
    };

export type ToolCancelReply =
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.cancelled';
      requestId: string;
      callId: string;
      attemptId: string;
      status: 'notFound';
    }
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.cancelled';
      requestId: string;
      callId: string;
      attemptId: string;
      status: ToolExecutionRecord['outcome'];
      record: ToolExecutionRecord;
    };

export interface KernelPort {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionReply>;
  cancel(callId: string, attemptId: string): Promise<ToolCancelReply>;
  readRecord(callId: string): Promise<ToolExecutionRecord | null>;
}

export interface JournalPort {
  append(event: NewSessionEvent): Promise<SessionEvent>;
  appendBatch(events: readonly NewSessionEvent[]): Promise<SessionEvent[]>;
  read(sessionId: string, afterSequence?: number): AsyncIterable<SessionEvent>;
}

export interface StoredCommand {
  command: ConversationCommand;
  reply: CommandReply;
}

export interface SessionCreationInput {
  sessionId: string;
  displayTitle: string;
  workspaceBindings: WorkspaceBindingDisplay[];
  profileId?: string;
}

/** Session journal owns atomic command admission; it is not a second state machine. */
export interface CommandJournalPort extends JournalPort {
  createSession(input: SessionCreationInput): Promise<SessionEvent>;
  deleteSession(sessionId: string): Promise<void>;
  readCommand(sessionId: string, commandId: string): Promise<StoredCommand | null>;
  commitCommand(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<CommandReply>;
}
