import type {
  LlmReviewGuidance,
  ReviewKernelFacts,
  ReviewPacket,
  ReviewPacketStatus,
  ReviewSelfCheckInput,
  ReviewToolResult,
  ReviewValidationFact,
} from './types.js';

export interface BuildReviewPacketInput {
  requirementId: string;
  runId: string;
  selfCheckInput: ReviewSelfCheckInput;
  llmGuidance: LlmReviewGuidance;
  auditRefs?: string[];
  diffSummary?: string;
  permissionSummary?: string;
  status?: ReviewPacketStatus;
}

export function buildReviewPacket(input: BuildReviewPacketInput): ReviewPacket {
  const kernelFacts = kernelFactsFromSelfCheckInput(input);
  return {
    requirementId: input.requirementId,
    runId: input.runId,
    status: input.status ?? 'waitingUserReview',
    selfCheckInput: input.selfCheckInput,
    kernelFacts,
    llmGuidance: input.llmGuidance,
  };
}

function kernelFactsFromSelfCheckInput(input: BuildReviewPacketInput): ReviewKernelFacts {
  const toolResults = input.selfCheckInput.toolResults;
  return {
    modifiedFiles: uniqueSorted(toolResults.flatMap((result) => result.modifiedFiles)),
    createdFiles: [],
    deletedFiles: [],
    commandsExecuted: commandResults(toolResults).map((result) => result.title),
    permissionDecisions: input.selfCheckInput.permissionDecisions,
    toolResults,
    validationResults: validationResultsFromCandidates(input),
    diffSummary: input.diffSummary,
    permissionSummary: input.permissionSummary,
    auditRefs: input.auditRefs ?? [],
  };
}

function commandResults(results: ReviewToolResult[]): ReviewToolResult[] {
  return results.filter((result) => result.toolName === 'shell.exec' || result.toolName === 'process.exec');
}

function validationResultsFromCandidates(input: BuildReviewPacketInput): ReviewValidationFact[] {
  return input.selfCheckInput.validationCandidates.map((candidate) => ({
    id: candidate.id,
    description: candidate.description,
    command: candidate.command,
    status: 'pending',
  }));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))].sort();
}
