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
import {
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from '../projection/conversationPresentationLanguage.js';

export interface NativeToolProjectionBuilderPorts {
  conversationActivity(input: AgentConversationActivity): AgentConversationActivity;
  packetActivity(
    packet: ResourcePacket,
    activityId: string,
    runId: string,
    language: ConversationPresentationLanguage
  ): AgentConversationActivity;
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
      payload: {
        visibility: 'hidden',
        presentation: 'traceOnly',
        nativeToolRound: input.nativeToolRound,
        toolCallCount: input.toolCallCount,
        resourcePacketCount: input.resourcePacketCount,
      },
    };
  }

  duplicateReadDelta(input: {
    sessionId: string;
    runId: string;
    language?: ConversationPresentationLanguage;
    toolCall: NativeToolCallProposal;
    existing: NativeToolReadLedgerEntry;
  }): ProjectionDelta {
    const language = input.language ?? 'neutral';
    const summary = localizedProjectionText(language, {
      zh: `Provider 重复请求了已解析目标的 ${input.toolCall.name}；Session 将复用现有 ResourcePacket，不再重复读取 Kernel。`,
      en: `Provider repeated ${input.toolCall.name} for an already resolved target; Session is reusing the existing ResourcePacket without another Kernel read.`,
      neutral: `ResourcePacket reuse: ${input.toolCall.name}`,
    });
    return {
      type: 'stage_delta',
      sessionId: input.sessionId,
      runId: input.runId,
      stage: 'native_tool_duplicate_read',
      status: 'completed',
      channel: 'tool',
      source: 'session',
      itemId: input.toolCall.callId,
      summary,
      activity: this.ports.conversationActivity({
        activityId: `native-tool-duplicate-${input.toolCall.callId}`,
        kind: 'resourceRead',
        status: 'completed',
        title: localizedProjectionText(language, {
          zh: '已复用重复的原生读取',
          en: 'Duplicate native read reused',
          neutral: 'Resource reuse',
        }),
        summary: localizedProjectionText(language, {
          zh: `Session 已为重复的 ${input.toolCall.name} 请求复用 ${input.existing.packet.id}。`,
          en: `Session reused ${input.existing.packet.id} for a repeated ${input.toolCall.name} request.`,
          neutral: `ResourcePacket ${input.existing.packet.id} reused`,
        }),
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
    activityId: string;
    nativeToolRound?: number;
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
        activityId: input.activityId,
        kind: 'toolExecution',
        status: 'running',
        title: localizedProjectionText(input.language, {
          zh: '正在解析原生读取工具',
          en: 'Resolving native read tool',
          neutral: 'Tool …',
        }),
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
    activityId: string;
    nativeToolRound?: number;
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
      activity: {
        ...this.ports.packetActivity(
          input.packet,
          input.activityId,
          input.runId,
          input.language
        ),
        toolName: input.toolCall.name,
        resourcePacketIds: [input.packet.id],
      },
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
