export type RequirementStatus = 'probing' | 'confirmed' | 'inProgress' | 'accepted' | 'backlog' | 'rejected';

export interface RequirementChecklist {
  goal: string;
  explicitTasks: string[];
  inferredTasks: string[];
  outOfScope: string[];
  affectedAreaCandidates: string[];
  resourceRequests: string[];
  acceptanceCriteriaCandidates: string[];
  clarificationQuestions: string[];
  riskNotes: string[];
}

export interface RequirementRecord {
  requirementId: string;
  sessionId: string;
  initialUserRequest: string;
  checklist?: RequirementChecklist;
  status: RequirementStatus;
  createdAt: string;
  updatedAt: string;
}

export type UserRequirementConfirmation =
  | { kind: 'confirmed' }
  | { kind: 'revised'; userRevision: string }
  | { kind: 'rejected'; reason: string };
