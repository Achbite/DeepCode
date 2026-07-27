import type {
  LlmChatRequest,
  ToolCall,
} from '@deepcode/protocol';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';

export interface NativeToolResumeTurn {
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

export interface NativeToolResumeMessageBuilderPorts {
  callToProtocol(toolCall: NativeToolCallProposal): ToolCall;
}

export class NativeToolResumeMessageBuilder {
  constructor(private readonly ports: NativeToolResumeMessageBuilderPorts) {}

  nextMessages(
    currentMessages: LlmChatRequest['messages'],
    turn: NativeToolResumeTurn,
    toolMessages: LlmChatRequest['messages']
  ): LlmChatRequest['messages'] {
    return [
      ...currentMessages,
      {
        role: 'assistant',
        content: turn.content,
        reasoningContent: turn.reasoning,
        toolCalls: turn.toolCalls.map((toolCall) => this.ports.callToProtocol(toolCall)),
      },
      ...toolMessages,
    ];
  }
}
