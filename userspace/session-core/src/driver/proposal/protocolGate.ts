import { parseProposalEnvelope } from '../../protocol/protocolV4.js';
import type { ProposalEnvelope, ProposalEnvelopeSource } from '../../protocol/types.js';

export interface ProtocolGatePorts {
  ensureReviewableExpectations(proposal: ProposalEnvelope): void;
  validateProposalSemantics(proposal: ProposalEnvelope, options?: {
    allowBriefActionBundleUserPlan?: boolean;
  }): void;
}

export interface ProtocolGateParseInput {
  raw: string | Record<string, unknown>;
  runId: string;
  sessionId?: string;
  source?: ProposalEnvelopeSource;
  allowBriefActionBundleUserPlan?: boolean;
}

export interface ProtocolGateRepairParseInput extends ProtocolGateParseInput {
  allowedKinds: string[];
}

export interface ProtocolGateAllowedKindsInput {
  acceptedPlanActive: boolean;
  errorCode: string;
}

export class ProtocolGate {
  constructor(private readonly ports: ProtocolGatePorts) {}

  parseAndValidateProposal(input: ProtocolGateParseInput): ProposalEnvelope {
    const proposal = parseProposalEnvelope(input);
    this.ports.ensureReviewableExpectations(proposal);
    this.ports.validateProposalSemantics(proposal, {
      allowBriefActionBundleUserPlan: input.allowBriefActionBundleUserPlan === true,
    });
    return proposal;
  }

  parseAndValidateRepairedProposal(input: ProtocolGateRepairParseInput): ProposalEnvelope {
    return this.parseAndValidateProposal(input);
  }

  repairAllowedKinds(input: ProtocolGateAllowedKindsInput): string[] {
    return input.acceptedPlanActive
      ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
      : ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'];
  }
}
