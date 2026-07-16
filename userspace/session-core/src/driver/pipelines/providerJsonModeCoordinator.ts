import type { LlmChatRequest } from '@deepcode/protocol';

const JSON_OBJECT_MODE_INSTRUCTION =
  'Return exactly one valid JSON object. Do not return markdown, prose outside JSON, or multiple JSON objects.';

export class ProviderJsonModeCoordinator {
  ensureMessages(
    messages: LlmChatRequest['messages'],
    responseFormat: unknown
  ): LlmChatRequest['messages'] {
    if (!this.isJsonObjectResponseFormat(responseFormat) || this.hasInjectedJsonInstruction(messages)) {
      return messages;
    }
    return [
      { role: 'system', content: JSON_OBJECT_MODE_INSTRUCTION },
      ...messages,
    ];
  }

  audit(
    messages: LlmChatRequest['messages'],
    responseFormat: unknown
  ): Record<string, unknown> | undefined {
    if (!this.isJsonObjectResponseFormat(responseFormat)) return undefined;
    const jsonInstructionPresent = this.hasInjectedJsonInstruction(messages);
    return {
      mode: 'json_object',
      jsonInstructionPresent,
      injectedJsonInstruction: !jsonInstructionPresent,
    };
  }

  private isJsonObjectResponseFormat(responseFormat: unknown): boolean {
    if (!responseFormat || typeof responseFormat !== 'object') return false;
    return (responseFormat as { type?: unknown }).type === 'json_object';
  }

  private hasInjectedJsonInstruction(messages: LlmChatRequest['messages']): boolean {
    const first = messages[0];
    return first?.role === 'system' && first.content === JSON_OBJECT_MODE_INSTRUCTION;
  }
}
