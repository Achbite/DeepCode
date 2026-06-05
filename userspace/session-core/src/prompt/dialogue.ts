import { stableHash } from '../cache/canonicalizer.js';

export interface DialogueMessageRef {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  summary: string;
  semanticHash: string;
}

export interface SyntheticDialoguePacket {
  id: string;
  requirementThreadId: string;
  planDialogueThreadId: string;
  messageRefs: DialogueMessageRef[];
  packetHash: string;
}

export function createSyntheticDialoguePacket(input: {
  id: string;
  requirementThreadId: string;
  planDialogueThreadId: string;
  messages: Array<{ id: string; role: DialogueMessageRef['role']; content: string }>;
  maxMessages?: number;
  maxSummaryChars?: number;
}): SyntheticDialoguePacket {
  const maxMessages = Math.max(1, input.maxMessages ?? 24);
  const maxSummaryChars = Math.max(32, input.maxSummaryChars ?? 600);
  const messageRefs = input.messages.slice(-maxMessages).map((message): DialogueMessageRef => {
    const summary = normalizeWhitespace(message.content).slice(0, maxSummaryChars);
    return {
      id: message.id,
      role: message.role,
      summary,
      semanticHash: stableHash(`${message.role}:${normalizeWhitespace(message.content)}`),
    };
  });
  return {
    id: input.id,
    requirementThreadId: input.requirementThreadId,
    planDialogueThreadId: input.planDialogueThreadId,
    messageRefs,
    packetHash: stableHash(JSON.stringify(messageRefs.map((message) => ({
      role: message.role,
      semanticHash: message.semanticHash,
    })))),
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
