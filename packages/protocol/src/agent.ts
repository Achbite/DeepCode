export type AgentMode = 'readOnly' | 'plan' | 'askBeforeWrite';
export type AgentWorkflowMode = 'planFirst' | 'actOnRequest';
export type AgentWorkflowStage = 'plan' | 'check' | 'complete' | 'review';

export const AGENT_WORKFLOW_STAGES: AgentWorkflowStage[] = [
  'plan',
  'check',
  'complete',
  'review',
];

export interface AgentWorkflowStageConfig {
  profileId?: string;
}

export type AgentWorkflowConfig = Record<AgentWorkflowStage, AgentWorkflowStageConfig>;

export interface GetAgentWorkflowConfigResult {
  config: AgentWorkflowConfig;
  storePath?: string;
  initialized: boolean;
}

export interface PatchAgentWorkflowConfigRequest {
  config: Partial<Record<AgentWorkflowStage, AgentWorkflowStageConfig | null>>;
}

export type AgentEventKind =
  | 'user_msg'
  | 'assistant_msg'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'permission_result'
  | 'workflow_stage'
  | 'error';

export interface AgentSession {
  id: string;
  title?: string;
  mode: AgentMode;
  profileId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentContextAttachment {
  kind: 'file' | 'directory';
  path: string;
  folderId?: string;
  source: 'mention' | 'contextMenu';
  scope: 'message' | 'session';
}

export interface AgentContextSnapshot {
  attachments: AgentContextAttachment[];
  promptText: string;
  truncated: boolean;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  diff?: string;
  argumentsPreview: unknown;
}

export interface PermissionDecision {
  action: 'allow' | 'ask' | 'deny';
  reason: string;
  request?: PermissionRequest;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  ts: string;
  kind: AgentEventKind;
  payload: unknown;
}

export interface CreateAgentSessionRequest {
  initialMode?: AgentMode;
  profileId?: string;
}

export interface SendAgentMessageRequest {
  content: string;
  attachments?: AgentContextAttachment[];
  mode?: AgentMode;
  workflow?: AgentWorkflowMode;
  workflowConfig?: AgentWorkflowConfig;
  profileId?: string;
}

export interface ResolveAgentPermissionRequest {
  decision: 'accept' | 'reject';
}

export interface AppendAgentEventsRequest {
  events: AgentEvent[];
}

export interface AgentSessionResult {
  session: AgentSession;
  events: AgentEvent[];
}
