import { AGENT_PROTOCOL_V3_SCHEMA_VERSION, parseProposalEnvelope } from '../../protocol/protocolV3.js';
import { AgentPlanParseError, type ProposalEnvelope, type ProposalEnvelopeSource } from '../../protocol/types.js';

export interface ProtocolGatePorts {
  canonicalizeWriteActionSourceBlockRefs(proposal: ProposalEnvelope): void;
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
    this.ports.canonicalizeWriteActionSourceBlockRefs(proposal);
    this.ports.ensureReviewableExpectations(proposal);
    this.ports.validateProposalSemantics(proposal, {
      allowBriefActionBundleUserPlan: input.allowBriefActionBundleUserPlan === true,
    });
    return proposal;
  }

  parseAndValidateRepairedProposal(input: ProtocolGateRepairParseInput): ProposalEnvelope {
    try {
      return this.parseAndValidateProposal(input);
    } catch (error) {
      const parseError = normalizeParseError(error);
      if (!isSchemaVersionRepairableError(parseError)) {
        throw error;
      }
      const canonical = this.canonicalizeBareRepairedProposal(input);
      if (!canonical) throw error;
      return this.parseAndValidateProposal({
        ...input,
        raw: canonical,
      });
    }
  }

  canonicalizeBareRepairedProposal(input: ProtocolGateRepairParseInput): Record<string, unknown> | null {
    const record = typeof input.raw === 'string'
      ? repairJsonObject(input.raw)
      : objectRecord(input.raw);
    if (!record) return null;
    const schemaVersion = repairString(record.schemaVersion);
    if (schemaVersion === AGENT_PROTOCOL_V3_SCHEMA_VERSION) return null;
    const allowedKinds = input.allowedKinds.filter((kind) => [
      'answer',
      'resourceRequest',
      'decisionRequest',
      'taskPlan',
      'actionBundle',
      'taskOutcome',
      'diagnostic',
    ].includes(kind));
    if (!allowedKinds.length) return null;
    const explicitKind = repairString(record.kind);
    const kind = explicitKind
      ? (allowedKinds.includes(explicitKind) ? explicitKind : undefined)
      : inferBareRepairKind(record, allowedKinds);
    if (!kind) return null;
    const payload = kindPayloadField(kind);
    if (!payload) return null;
    const hasKindPayload = record[payload] !== undefined;
    const canonical: Record<string, unknown> = {
      ...record,
      schemaVersion: AGENT_PROTOCOL_V3_SCHEMA_VERSION,
      kind,
      runId: repairString(record.runId) ?? input.runId,
      sessionId: repairString(record.sessionId) ?? input.sessionId,
      source: repairString(record.source) ?? input.source ?? 'llm',
    };
    if (!hasKindPayload) {
      canonical[payload] = stripBareRepairEnvelopeFields(record);
    }
    return canonical;
  }

  repairAllowedKinds(input: ProtocolGateAllowedKindsInput): string[] {
    if (input.errorCode === 'action_bundle_budget_exceeded') {
      return ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic'];
    }
    return input.acceptedPlanActive
      ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic']
      : ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'];
  }
}

function inferBareRepairKind(record: Record<string, unknown>, allowedKinds: string[]): string | undefined {
  const fields = allowedKinds.filter((kind) => {
    const field = kindPayloadField(kind);
    return Boolean(field && record[field] !== undefined);
  });
  if (fields.length === 1) return fields[0];
  const shapeKinds = allowedKinds.filter((kind) => bareRepairShapeMatches(kind, record));
  return shapeKinds.length === 1 ? shapeKinds[0] : undefined;
}

function bareRepairShapeMatches(kind: string, record: Record<string, unknown>): boolean {
  if (kind === 'taskPlan') return Array.isArray(record.tasks);
  if (kind === 'resourceRequest') return Array.isArray(record.items) || Array.isArray(record.resources) || Array.isArray(record.requests);
  if (kind === 'decisionRequest') return typeof repairString(record.question) === 'string' && Array.isArray(record.options);
  if (kind === 'answer') return typeof repairString(record.content) === 'string' || typeof repairString(record.markdown) === 'string';
  if (kind === 'diagnostic') return typeof repairString(record.summary) === 'string' && typeof repairString(record.severity) === 'string';
  if (kind === 'actionBundle') return Array.isArray(record.actions) || record.actionBundle !== undefined;
  if (kind === 'taskOutcome') return typeof repairString(record.reason) === 'string' || typeof repairString(record.summary) === 'string';
  return false;
}

function kindPayloadField(kind: string): string | undefined {
  if (kind === 'answer') return 'answer';
  if (kind === 'resourceRequest') return 'resourceRequest';
  if (kind === 'decisionRequest') return 'decisionRequest';
  if (kind === 'taskPlan') return 'taskPlan';
  if (kind === 'diagnostic') return 'diagnostic';
  if (kind === 'actionBundle') return 'actionBundle';
  if (kind === 'taskOutcome') return 'taskOutcome';
  return undefined;
}

function stripBareRepairEnvelopeFields(record: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ([
      'schemaVersion',
      'proposalId',
      'runId',
      'sessionId',
      'source',
      'kind',
      'narration',
      'referencedResourcePacketRefs',
      'referencedEvidenceRefs',
      'parserDiagnostics',
      'outputLanguage',
    ].includes(key)) continue;
    stripped[key] = value;
  }
  return stripped;
}

function repairJsonObject(raw: string): Record<string, unknown> | null {
  const candidate = repairJsonCandidate(raw);
  if (!candidate) return null;
  try {
    return objectRecord(JSON.parse(candidate)) ?? null;
  } catch {
    return null;
  }
}

function repairJsonCandidate(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function normalizeParseError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPlanParseError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'parse_failed', message: error.message };
  return { code: 'parse_failed', message: String(error) };
}

function isSchemaVersionRepairableError(error: { code: string; message: string }): boolean {
  if (!error.message.includes('schemaVersion')) return false;
  return error.code === 'missing_string' || error.code === 'unsupported_protocol_schema';
}

function repairString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
