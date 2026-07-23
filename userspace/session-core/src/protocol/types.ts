import type { ConversationLanguage } from '@deepcode/protocol';

export interface ContentBlockDraft {
  blockId: string;
  targetPath: string;
  contentLines: string[];
  language?: string;
  operation?:
    | 'create'
    | 'createEmpty'
    | 'overwrite'
    | 'patch'
    | 'replaceBlock'
    | 'insertBefore'
    | 'insertAfter'
    | 'delete'
    | 'rename';
  allowEmptyContent?: boolean;
}

export interface PlannedActionDraft {
  actionId: string;
  toolId: string;
  args: Record<string, unknown>;
  description: string;
  dependsOn?: string[];
}

export interface ValidationExpectationDraft {
  id: string;
  description: string;
}

export interface ReviewExpectationDraft {
  id: string;
  description: string;
}

export interface ContinuationExpectationDraft {
  id: string;
  description: string;
  target?: string[];
  reason?: string;
  dependsOn?: string[];
}

export interface ActionBundleDraft {
  version: '1';
  id: string;
  goal: string;
  requirementId?: string;
  actions: PlannedActionDraft[];
  continuationExpectations?: ContinuationExpectationDraft[];
  validationExpectations: ValidationExpectationDraft[];
  reviewExpectations: ReviewExpectationDraft[];
}

export interface ResourceRequestDraftItem {
  id: string;
  kind?: 'file' | 'directory' | 'resource' | 'search';
  manifestEntryId?: string;
  path?: string;
  rootId?: string;
  query?: string;
  include?: string[];
  contextLines?: number;
  maxResults?: number;
  offsetBytes?: number;
  limitBytes?: number;
  reason: string;
}

export interface ResourceRequestDraft {
  version: '1';
  id: string;
  reason: string;
  items: ResourceRequestDraftItem[];
}

export interface AnswerDraft {
  format: 'markdown';
  version: '1';
  content: string;
}

export interface DecisionRequestOptionDraft {
  id: string;
  label: string;
  labelKey?: string;
  description: string;
  descriptionKey?: string;
  messageArgs?: Record<string, string>;
  recommended?: boolean;
  effect?: AgentRequirementOptionEffect;
}

export type AgentRequirementOptionEffect =
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

export interface DecisionRequestDraft {
  version: '1';
  id: string;
  reason: string;
  summary: string;
  options: DecisionRequestOptionDraft[];
  allowsFreeform: boolean;
}

export interface DiagnosticDraft {
  version: '1';
  id: string;
  severity: 'info' | 'warning' | 'error';
  summary: string;
  details?: string;
}

export interface TaskPlanTaskDraft {
  taskId: string;
  title: string;
  target: string[];
  dependencies: string[];
  args: Record<string, unknown>;
  conflictKeys?: string[];
  batchKind?: 'sourceCode' | 'infra' | 'script' | 'test' | 'docs' | 'config' | 'review' | string;
  toolId: string;
  acceptanceCriteria: string[];
  failureCriteria: string[];
}

export interface TaskPlanDraft {
  version: '1';
  id: string;
  title: string;
  summary: string;
  tasks: TaskPlanTaskDraft[];
  risks: string[];
  reviewCheckpoints: string[];
}

export interface AgentPlanParseFailure {
  code: string;
  message: string;
}

export type ProposalEnvelopeSource = 'llm' | 'user' | 'system' | 'cache';

export type ProposalEnvelopeKind =
  | 'answer'
  | 'resourceRequest'
  | 'decisionRequest'
  | 'taskPlan'
  | 'actionBundle'
  | 'diagnostic';

export interface ProposalEnvelope {
  schemaVersion: 'deepcode.agent.protocol.v4';
  proposalId: string;
  runId: string;
  sessionId?: string;
  source: ProposalEnvelopeSource;
  kind: ProposalEnvelopeKind;
  responseLanguage?: ConversationLanguage;
  narration?: string;
  payload: unknown;
  referencedResourcePacketRefs: string[];
  referencedEvidenceRefs: string[];
  parserDiagnostics?: unknown;
}

export class AgentPlanParseError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentPlanParseError';
  }
}
