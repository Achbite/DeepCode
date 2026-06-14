export type ActionKind =
  | 'read'
  | 'write'
  | 'delete'
  | 'command'
  | 'validation'
  | 'review'
  | 'repair';

export interface CodeBlockDraft {
  id: string;
  path: string;
  content: string;
  language?: string;
}

export interface PlannedActionDraft {
  id: string;
  title: string;
  capability: string;
  kind?: ActionKind;
  resourceScope: string[];
  canParallelize: boolean;
  conflictKeys: string[];
  purpose?: string;
  sourceBlockId?: string;
}

export interface ValidationExpectationDraft {
  id: string;
  description: string;
  command?: string;
}

export interface ReviewExpectationDraft {
  id: string;
  description: string;
}

export interface RepairPolicyDraft {
  maxRounds: number;
  allowedFiles: string[];
  forbidNewFilesAfterApproval: boolean;
  forbidNewPermissionsAfterApproval: boolean;
}

export interface ActionBundleDraft {
  version: '1';
  id: string;
  goal: string;
  requirementId?: string;
  actions: PlannedActionDraft[];
  continuationExpectations?: PlannedActionDraft[];
  validationExpectations: ValidationExpectationDraft[];
  reviewExpectations: ReviewExpectationDraft[];
  repairPolicy?: RepairPolicyDraft;
}

export interface ExpectedValidation {
  content: string;
  expectations: ValidationExpectationDraft[];
}

export interface ReviewGuide {
  content: string;
  expectations: ReviewExpectationDraft[];
}

export interface ResourceRequestDraftItem {
  id: string;
  manifestEntryId?: string;
  path?: string;
  rootId?: string;
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

export interface AgentPlanParts {
  userPlan: string;
  actionBundle: ActionBundleDraft;
  codeBlocks: CodeBlockDraft[];
  expectedValidation: ExpectedValidation;
  reviewGuide: ReviewGuide;
}

export type AgentPlanOutput =
  | {
      kind: 'answer';
      answer: AnswerDraft;
    }
  | {
      kind: 'actionPlan';
      parts: AgentPlanParts;
    }
  | {
      kind: 'resourceRequest';
      userPlan?: string;
      resourceRequest: ResourceRequestDraft;
    };

export interface AgentPlanParseFailure {
  code: string;
  message: string;
}

export type ProposalEnvelopeSource = 'llm' | 'user' | 'system' | 'cache';

export type ProposalEnvelopeKind =
  | 'answer'
  | 'resourceRequest'
  | 'requirementDraft'
  | 'actionBundle'
  | 'repairProposal'
  | 'reviewPacketDraft';

export interface ProposalEnvelope {
  schemaVersion: 'deepcode.agent.protocol.v3';
  proposalId: string;
  runId: string;
  sessionId?: string;
  source: ProposalEnvelopeSource;
  kind: ProposalEnvelopeKind;
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
