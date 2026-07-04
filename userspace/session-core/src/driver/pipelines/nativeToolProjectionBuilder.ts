import type {
  AgentConversationActivity,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type {
  NativeToolCallProposal,
  NativeToolReadLedgerEntry,
} from '../../provider/providerStreamParts.js';
import type { ProviderStreamVisibleLanguage } from './providerStreamCoordinator.js';

export interface NativeToolProjectionBuilderPorts {
  conversationActivity(input: AgentConversationActivity): AgentConversationActivity;
  packetActivity(packet: ResourcePacket, activityId: string, runId: string): AgentConversationActivity;
  runningSummary(toolName: string, language: ProviderStreamVisibleLanguage): string;
  completedSummary(toolName: string, language: ProviderStreamVisibleLanguage): string;
}

export class NativeToolProjectionBuilder {
  constructor(private readonly ports: NativeToolProjectionBuilderPorts) {}

  checkpointDelta(input: {
    sessionId: string;
    runId: string;
    nativeToolRound: number;
    toolCallCount: number;
    resourcePacketCount: number;
  }): ProjectionDelta {
    return {
      type: 'stage_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: `native_tool_round_${input.nativeToolRound + 1}`,
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: 'native_tool_checkpoint',
      activity: this.ports.conversationActivity({
        activityId: `native-tool-round-${input.nativeToolRound + 1}`,
        kind: 'toolExecution',
        status: 'running',
        title: 'Native tool checkpoint',
        summary: 'Provider requested read-only native tools. Session is routing them through Kernel resource boundaries.',
        source: 'session',
        runId: input.runId,
        itemCount: input.toolCallCount,
      }),
      payload: {
        visibility: 'task',
        nativeToolRound: input.nativeToolRound,
        toolCallCount: input.toolCallCount,
        resourcePacketCount: input.resourcePacketCount,
      },
    };
  }

  duplicateReadDelta(input: {
    sessionId: string;
    runId: string;
    toolCall: NativeToolCallProposal;
    existing: NativeToolReadLedgerEntry;
  }): ProjectionDelta {
    return {
      type: 'stage_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: 'native_tool_duplicate_read',
      status: 'completed',
      channel: 'tool',
      source: 'session',
      itemId: input.toolCall.callId,
      summary: `Provider repeated ${input.toolCall.name} for an already resolved target; Session is reusing the existing ResourcePacket without another Kernel read.`,
      activity: this.ports.conversationActivity({
        activityId: `native-tool-duplicate-${input.toolCall.callId}`,
        kind: 'resourceRead',
        status: 'completed',
        title: 'Duplicate native read reused',
        summary: `Session reused ${input.existing.packet.id} for a repeated ${input.toolCall.name} request.`,
        source: 'session',
        runId: input.runId,
        toolName: input.toolCall.name,
        targets: [input.existing.signature.path],
      }),
      payload: {
        callId: input.toolCall.callId,
        name: input.toolCall.name,
        duplicateOfPacketId: input.existing.packet.id,
        duplicateCount: input.existing.repeatCount,
        signature: input.existing.signature,
        contentHash: input.existing.contentHash,
      },
    };
  }

  toolCallRunningDelta(input: {
    sessionId: string;
    runId: string;
    language: ProviderStreamVisibleLanguage;
    toolCall: NativeToolCallProposal;
    nativeToolRound: number;
  }): ProjectionDelta {
    const summary = this.ports.runningSummary(input.toolCall.name, input.language);
    return {
      type: 'tool_call_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: 'native_tool_call',
      status: 'running',
      channel: 'tool',
      source: 'session',
      itemId: input.toolCall.callId,
      summary,
      activity: this.ports.conversationActivity({
        activityId: `native-tool-${input.toolCall.callId}`,
        kind: 'toolExecution',
        status: 'running',
        title: 'Resolving native read tool',
        summary,
        source: 'session',
        runId: input.runId,
        toolName: input.toolCall.name,
      }),
      payload: {
        callId: input.toolCall.callId,
        name: input.toolCall.name,
        arguments: input.toolCall.arguments,
        nativeToolRound: input.nativeToolRound,
      },
    };
  }

  resourceResolvedDelta(input: {
    sessionId: string;
    runId: string;
    language: ProviderStreamVisibleLanguage;
    toolCall: NativeToolCallProposal;
    packet: ResourcePacket;
    nativeToolRound: number;
    resourcePacketCount: number;
  }): ProjectionDelta {
    return {
      type: 'resource_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: 'native_tool_resource_resolve',
      status: 'completed',
      channel: 'resource',
      source: 'kernel',
      itemId: input.toolCall.callId,
      summary: this.ports.completedSummary(input.toolCall.name, input.language),
      activity: this.ports.packetActivity(
        input.packet,
        `native-tool-resource-${input.toolCall.callId}`,
        input.runId
      ),
      payload: {
        callId: input.toolCall.callId,
        packetId: input.packet.id,
        itemCount: input.packet.items.length,
        nativeToolRound: input.nativeToolRound,
        resourcePacketCount: input.resourcePacketCount,
      },
    };
  }
}
