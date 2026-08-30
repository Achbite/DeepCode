export const LOCAL_AGENT_PROTOCOL_VERSION = 'deepcode.local-agent' as const;
export const CONVERSATION_COMMAND_VERSION = 'deepcode.command' as const;
export const COMMAND_REPLY_VERSION = 'deepcode.command-reply' as const;
export const SESSION_EVENT_VERSION = 'deepcode.session-event' as const;
export const SESSION_PROJECTION_VERSION = 'deepcode.session-projection' as const;
export const PROVIDER_EVENT_VERSION = 'deepcode.provider-event' as const;
export const KERNEL_REQUEST_VERSION = 'deepcode.kernel-request' as const;
export const KERNEL_REPLY_VERSION = 'deepcode.kernel-reply' as const;
export const SESSION_CONTROL_INTERACTION_REQUEST = 'interaction.request' as const;
export const SESSION_CONTROL_PLAN_PUBLISH = 'plan.publish' as const;
export const SESSION_CONTROL_TODO_PROGRESS = 'todo.progress' as const;
export const SESSION_CONTROL_CONTEXT_FOCUS = 'context.focus' as const;

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

export interface UserMessageAttachment {
  attachmentId: string;
  name: string;
  mediaType: string;
  content: string;
}

export interface MessageAttachmentProjection {
  attachmentId: string;
  name: string;
  mediaType: string;
  byteLength: number;
}

/** Logical directory reference owned by one user message; absolute roots remain Host-private. */
export interface MessageDirectoryAttachment extends WorkspaceBindingDisplay {}

export type PlanOperationName =
  | 'fs.create'
  | 'fs.write'
  | 'fs.edit'
  | 'fs.delete'
  | 'fs.ensure_directory';

export type PlanOperation =
  | {
      workspaceId: string;
      operation: Exclude<PlanOperationName, 'fs.delete'>;
      target: string;
    }
  | {
      workspaceId: string;
      operation: 'fs.delete';
      target: string;
      targetKind: 'file' | 'directoryTree';
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
      attachments?: UserMessageAttachment[];
      directoryAttachments?: MessageDirectoryAttachment[];
      profileId?: string;
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
      type: 'run.profile.select';
      commandId: string;
      sessionId: string;
      runId: string;
      profileId: string;
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
  runId: string;
  sequence: number;
  updatedAt: string;
}

export interface TokenUsageProjection {
  providerCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheMissInputTokens: number;
  cacheReportedCallCount: number;
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
  | 'messageAttachments'
  | 'tools';

export interface ContextCompositionItem {
  itemId: string;
  label: string;
}

export type ContextCompositionMessageKind = Exclude<
  ContextCompositionPartitionKind,
  'messageAttachments' | 'tools'
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
  attachments: ContextCompositionItem[];
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

export interface ContextCompositionReceipt {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  responseConstraint: 'normal' | 'answerOnly';
  messages: ContextCompositionMessage[];
  workspaceBindings: ContextCompositionItem[];
  tools: ContextCompositionItem[];
  partitions: ContextCompositionPartitionReceipt[];
}

interface ContextCompositionProjectionBase {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  responseConstraint: 'normal' | 'answerOnly';
  runId: string;
  sequence: number;
  createdAt: string;
}

export interface ContextCompositionProjection extends ContextCompositionProjectionBase {
  messages: ContextCompositionMessage[];
  workspaceBindings: ContextCompositionItem[];
  tools: ContextCompositionItem[];
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

export type ContextCompactionTrigger = 'pressure' | 'userFocus' | 'agentFocus';

export type ContextCompactionRequestPayload = {
  compactionId: string;
  providerRequestId: string;
  coveredThroughSequence: number;
} & (
  | { trigger: 'pressure' }
  | { trigger: 'userFocus'; focus: string; commandId: string }
  | { trigger: 'agentFocus'; focus: string; providerCallId: string }
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
      payload: { commandId: string; messageId: string; text: string };
    })
  | (SessionEventBase & {
      type: 'run.started';
      runId: string;
      payload: {
        inputMessageId: string;
        workspaceBindings: WorkspaceBindingDisplay[];
        profileId?: string;
      };
    })
  | (SessionEventBase & {
      type: 'run.profile.selected';
      runId: string;
      payload: { commandId: string; profileId: string };
    })
  | (SessionEventBase & {
      type: 'message.committed';
      runId?: string;
      callId?: string;
      payload: {
        messageId: string;
        role: 'user' | 'assistant' | 'tool' | 'system';
        content: string;
        attachments?: UserMessageAttachment[];
        directoryAttachments?: MessageDirectoryAttachment[];
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
      payload: { narrativeId: string; content: string };
    })
  | (SessionEventBase & {
      type: 'interaction.requested';
      runId: string;
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
      callId: string;
      payload: {
        providerCallId: string;
        sourcePlanId: string;
        sourcePlanRevision: number;
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
      callId?: string;
      payload: ContextCompactionRequestPayload;
    })
  | (SessionEventBase & {
      type: 'context.compacted';
      runId: string;
      callId?: string;
      payload: ContextCompactedPayload;
    })
  | (SessionEventBase & {
      type: 'context.composed';
      runId: string;
      payload: ContextCompositionReceipt;
    })
  | (SessionEventBase & {
      type: 'context.updated';
      runId: string;
      payload: ProviderTokenUsage & { providerRequestId: string };
    })
  | (SessionEventBase & {
      type: 'run.waiting';
      runId: string;
      payload: { reason: 'approval' | 'userInput' | 'plan'; detail?: string };
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

export interface ProjectionMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  attachments: MessageAttachmentProjection[];
  directoryAttachments: MessageDirectoryAttachment[];
  feedback: MessageFeedback | null;
  sequence: number;
  createdAt: string;
}

export interface NarrativeProjection {
  narrativeId: string;
  runId: string;
  content: string;
  sequence: number;
  createdAt: string;
}

export interface InteractionProjection extends ModelInteractionRequest {
  interactionId: string;
  runId: string;
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

export interface RunProjection {
  runId: string;
  profileId?: string;
  waitingReason?: 'approval' | 'userInput' | 'plan';
  /** Immutable effective directory set captured by run.started. */
  workspaceBindings: WorkspaceBindingDisplay[];
  status:
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'indeterminate';
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
  environment?: ShellExecutionEnvironmentProjection;
}

export interface ShellExecutionEnvironmentProjection {
  shell: string;
  interactive: false;
  pathSource: 'hostPlusStandardDeveloperPaths';
  writeScope: 'workspaceAndKernelTemporary';
  homeWritable: false;
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

export interface ProviderRequest {
  protocolVersion: typeof LOCAL_AGENT_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  runId: string;
  profileId?: string;
  purpose: 'agent' | 'contextCompaction';
  responseConstraint: 'normal' | 'answerOnly';
  maxOutputTokens?: number;
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

export interface PlanAuthority {
  authorityId: string;
  planId: string;
  revision: number;
  decisionId: string;
  sessionId: string;
  workspaceId: string;
  coveredOperations: PlanOperation[];
}

export interface PreparedEffectProjection {
  callId: string;
  attemptId: string;
  sessionId: string;
  runId: string;
  toolName: string;
  workspaceId?: string;
  operation: string;
  logicalTargets: string[];
  canonicalInvocation: JsonObject;
}

export interface ToolExecutionRequest {
  schemaVersion: typeof KERNEL_REQUEST_VERSION;
  type: 'tool.execute';
  requestId: string;
  sessionId: string;
  runId: string;
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

export type AuthorityDecision =
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
  | { decision: 'allow'; source: 'user' | 'userSetting'; authorityId: string }
  | { decision: 'deny'; source: 'kernel' | 'user' | 'userSetting'; reason: string };

interface ToolExecutionRecordBase {
  recordId: string;
  sessionId: string;
  runId: string;
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
  | (ToolExecutionRecordBase & { outcome: 'failed'; error: LocalAgentError })
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
  listTools(): Promise<readonly ToolDescriptor[]>;
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
