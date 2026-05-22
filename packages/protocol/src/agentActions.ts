import type { AgentMode } from './agent.js';

export type ParsedAgentActionType =
  | 'fs.read'
  | 'fs.list'
  | 'code.search'
  | 'patch.plan'
  | 'fs.write'
  | 'fs.diff'
  | 'shell.propose'
  | 'shell.exec'
  | 'final';

export interface ParsedAgentActionError {
  code: string;
  message: string;
}

export interface ParsedAgentAction {
  id: string;
  sourceMessageId: string;
  type: ParsedAgentActionType;
  payload: unknown;
  parseSource: 'jsonBlock' | 'tag';
  status: 'parsed' | 'invalid' | 'blocked';
  errors?: ParsedAgentActionError[];
}

export interface AgentActionParseRequest {
  content: string;
  sourceMessageId?: string;
  mode?: AgentMode;
}

export interface AgentActionParseResult {
  sourceMessageId: string;
  actions: ParsedAgentAction[];
  errors: ParsedAgentActionError[];
  naturalText: string;
}

export interface AgentObservation {
  id: string;
  sessionId: string;
  actionId: string;
  toolName: string;
  status: 'ok' | 'error' | 'blocked' | 'needsApproval';
  summary: string;
  dataRef?: string;
  output?: unknown;
  error?: ParsedAgentActionError;
  createdAt: string;
}

export interface AgentFixtureRunRequest extends AgentActionParseRequest {
  sessionId?: string;
  execute?: boolean;
  approveAll?: boolean;
  approvedActionIds?: string[];
  approvedToolNames?: string[];
}

export interface AgentFixtureRunResult {
  parse: AgentActionParseResult;
  observations: AgentObservation[];
}

export interface PromptLayer {
  id: string;
  kind: 'builtin' | 'global' | 'user' | 'workspace' | 'session' | 'message';
  path?: string;
  priority: number;
  contentHash: string;
  title?: string;
}

export interface SkillReference {
  id: string;
  name: string;
  path: string;
  scope: 'global' | 'user' | 'workspace';
  enabled: boolean;
  description?: string;
}

export interface PromptLayerResult {
  layers: PromptLayer[];
}

export interface SkillReferenceResult {
  skills: SkillReference[];
}
