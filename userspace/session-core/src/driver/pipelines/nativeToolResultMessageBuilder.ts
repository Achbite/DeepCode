import type { LlmChatRequest } from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type {
  NativeToolCallProposal,
  NativeToolReadLedgerEntry,
} from '../../provider/providerStreamParts.js';

export interface NativeToolResultMessageBuilderPorts {
  duplicateResult(toolCall: NativeToolCallProposal, existing: NativeToolReadLedgerEntry): unknown;
  resultFromPacket(toolCall: NativeToolCallProposal, packet: ResourcePacket): unknown;
}

export class NativeToolResultMessageBuilder {
  constructor(
    private readonly ports: NativeToolResultMessageBuilderPorts,
    private readonly maxChars: number
  ) {}

  duplicateToolMessage(
    toolCall: NativeToolCallProposal,
    existing: NativeToolReadLedgerEntry
  ): LlmChatRequest['messages'][number] {
    return {
      role: 'tool',
      toolCallId: toolCall.callId,
      content: this.clipJson(this.ports.duplicateResult(toolCall, existing)),
    };
  }

  packetToolMessage(
    toolCall: NativeToolCallProposal,
    packet: ResourcePacket
  ): LlmChatRequest['messages'][number] {
    return {
      role: 'tool',
      toolCallId: toolCall.callId,
      content: this.clipJson(this.ports.resultFromPacket(toolCall, packet)),
    };
  }

  private clipJson(value: unknown): string {
    const json = JSON.stringify(value);
    return json.length > this.maxChars
      ? `${json.slice(0, this.maxChars)}...`
      : json;
  }
}
