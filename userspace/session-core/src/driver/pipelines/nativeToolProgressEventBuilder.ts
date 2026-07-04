export class NativeToolProgressEventBuilder {
  assistantProgressPayload(input: {
    runId: string;
    content: string;
  }): Record<string, unknown> {
    return {
      content: input.content,
      channel: 'progress',
      source: 'llm',
      visibility: 'conversation',
      presentation: 'body',
      runId: input.runId,
    };
  }
}
