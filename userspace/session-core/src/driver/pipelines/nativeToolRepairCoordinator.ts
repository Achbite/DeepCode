import type {
  AgentConversationActivity,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  NativeToolCallProposal,
  NativeToolReadLedgerEntry,
  NativeToolReadSignature,
} from '../../provider/providerStreamParts.js';

export interface NativeToolTurnProposalLike {
  content: string;
}

export interface NativeToolRepairDuplicate {
  toolCall: NativeToolCallProposal;
  signature: NativeToolReadSignature;
  entry: NativeToolReadLedgerEntry;
}

export interface NativeToolRepairCoordinatorPorts {
  conversationActivity(input: {
    activityId: string;
    kind: AgentConversationActivity['kind'];
    status: AgentConversationActivity['status'];
    title: string;
    summary: string;
    source: AgentConversationActivity['source'];
    runId: string;
    toolName?: string;
    targets?: string[];
  }): AgentConversationActivity;
  parseProposal(input: {
    raw: string;
    runId: string;
    sessionId: string;
    source: 'llm';
  }): ProposalEnvelope;
  parseRepairedProposal(input: {
    raw: string;
    runId: string;
    sessionId: string;
    source: 'llm';
    allowedKinds: string[];
  }): ProposalEnvelope;
}

export class NativeToolRepairCoordinator {
  constructor(private readonly ports: NativeToolRepairCoordinatorPorts) {}

  sideEffectAllowedKinds(acceptedExecution: boolean): string[] {
    return acceptedExecution
      ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
      : ['decisionRequest', 'taskPlan', 'resourceRequest', 'diagnostic'];
  }

  duplicateRepairAllowedKinds(): string[] {
    return ['resourceRequest', 'decisionRequest', 'diagnostic'];
  }

  sideEffectBlockedDelta(input: {
    sessionId: string;
    runId: string;
    toolCall: NativeToolCallProposal;
  }): ProjectionDelta {
    return {
      type: 'stage_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: 'native_tool_side_effect_blocked',
      status: 'failed',
      channel: 'progress',
      source: 'session',
      summary: 'side_effect_native_tool_blocked',
      activity: this.ports.conversationActivity({
        activityId: `native-tool-side-effect-${input.toolCall.callId}`,
        kind: 'diagnostic',
        status: 'failed',
        title: 'Native tool blocked',
        summary: 'Provider requested a side-effect tool. Session is converting it back through the plan/permission path.',
        source: 'session',
        runId: input.runId,
        toolName: input.toolCall.name,
      }),
      payload: {
        visibility: 'task',
        callId: input.toolCall.callId,
        name: input.toolCall.name,
      },
    };
  }

  duplicateRepairDelta(input: {
    sessionId: string;
    runId: string;
    duplicates: NativeToolRepairDuplicate[];
  }): ProjectionDelta {
    return {
      type: 'stage_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: 'native_tool_duplicate_repair',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: 'Provider repeated already resolved read-only native tool targets; Session is requesting a no-tool proposal.',
      activity: this.ports.conversationActivity({
        activityId: `native-tool-duplicate-repair-${input.runId}`,
        kind: 'diagnostic',
        status: 'running',
        title: 'Duplicate native read repair',
        summary: 'Session detected repeated read-only native tool calls with no new evidence.',
        source: 'session',
        runId: input.runId,
        targets: input.duplicates.map((item) => item.signature.path),
      }),
      payload: {
        visibility: 'task',
        duplicateTargets: input.duplicates.map((item) => ({
          callId: item.toolCall.callId,
          toolName: item.toolCall.name,
          signature: item.signature,
          packetId: item.entry.packet.id,
          contentHash: item.entry.contentHash,
          repeatCount: item.entry.repeatCount,
        })),
      },
    };
  }

  duplicateLoopError(duplicates: NativeToolRepairDuplicate[]): { code: string; message: string } {
    const duplicateSummary = duplicates
      .map((item) => `${item.toolCall.name}:${item.signature.path}`)
      .join(', ');
    return {
      code: 'native_tool_duplicate_loop',
      message: `Provider repeated already-resolved read-only native tool calls after repair: ${duplicateSummary}. Session stopped the run to avoid an infinite ResourceResolve loop.`,
    };
  }

  parseTurnProposal(input: {
    turn: NativeToolTurnProposalLike;
    runId: string;
    sessionId: string;
  }): ProposalEnvelope | null {
    if (!input.turn.content.trim().startsWith('{')) return null;
    try {
      return this.ports.parseProposal({
        raw: input.turn.content,
        runId: input.runId,
        sessionId: input.sessionId,
        source: 'llm',
      });
    } catch {
      return null;
    }
  }

  parseSideEffectRepair(input: {
    raw: string;
    runId: string;
    sessionId: string;
    acceptedExecution: boolean;
  }): ProposalEnvelope {
    return this.ports.parseRepairedProposal({
      raw: input.raw,
      runId: input.runId,
      sessionId: input.sessionId,
      source: 'llm',
      allowedKinds: this.sideEffectAllowedKinds(input.acceptedExecution),
    });
  }

  parseDuplicateRepair(input: {
    raw: string;
    runId: string;
    sessionId: string;
  }): ProposalEnvelope {
    return this.ports.parseRepairedProposal({
      raw: input.raw,
      runId: input.runId,
      sessionId: input.sessionId,
      source: 'llm',
      allowedKinds: this.duplicateRepairAllowedKinds(),
    });
  }
}
