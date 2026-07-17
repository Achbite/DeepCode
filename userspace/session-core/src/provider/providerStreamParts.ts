import type {
  AgentStreamPartFrame,
  LlmChatResult,
} from '@deepcode/protocol';

export { ProviderEmptyProposalRetry } from './ProviderEmptyProposalRetry.js';
export {
  NativeToolCoordinator,
  NativeToolCoordinatorError,
  type NativeToolReadLedgerEntry,
  type NativeToolReadSignature,
} from './NativeToolCoordinator.js';
export {
  NativeToolTurnHandler,
  type NativeToolHandlingResult,
  type NativeToolTurnResult,
} from './NativeToolTurnHandler.js';

export interface NativeToolCallProposal {
  callId: string;
  index: number;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

export interface ProviderToolCallBufferOptions {
  parseArguments(raw: string, toolName: string): Record<string, unknown>;
  normalizeToolName(name: string): string;
}

interface ProviderToolCallBufferItem {
  callId?: string;
  name?: string;
  argumentsText: string;
}

export class ProviderPartFrameParser {
  private buffer = '';

  push(content: string): AgentStreamPartFrame[] {
    this.buffer = `${this.buffer}${content}`;
    if (this.buffer.length > 512 * 1024) {
      this.buffer = this.buffer.slice(-256 * 1024);
    }
    return [
      ...this.consumeNdjsonFrames(),
      ...this.consumeTaggedFrames(),
    ];
  }

  private consumeTaggedFrames(): AgentStreamPartFrame[] {
    const frames: AgentStreamPartFrame[] = [];
    const startTag = '<deepcode-part>';
    const endTag = '</deepcode-part>';
    while (true) {
      const start = this.buffer.indexOf(startTag);
      if (start < 0) {
        if (this.buffer.length > startTag.length) {
          this.buffer = this.buffer.slice(-(startTag.length - 1));
        }
        break;
      }
      const payloadStart = start + startTag.length;
      const end = this.buffer.indexOf(endTag, payloadStart);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.slice(start);
        break;
      }
      const raw = this.buffer.slice(payloadStart, end);
      this.buffer = this.buffer.slice(end + endTag.length);
      const frame = parseProviderPartFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private consumeNdjsonFrames(): AgentStreamPartFrame[] {
    const frames: AgentStreamPartFrame[] = [];
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      if (!line.includes('"deepcode.agent.stream.part.v1"')) break;
      this.buffer = this.buffer.slice(newline + 1);
      const frame = parseProviderPartFrame(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

export class ProviderToolCallBuffer {
  private readonly items = new Map<number, ProviderToolCallBufferItem>();

  constructor(private readonly options: ProviderToolCallBufferOptions) {}

  addChunk(chunk: LlmChatResult['chunks'][number]): void {
    if (chunk.toolCall) {
      const index = typeof chunk.index === 'number' ? chunk.index : this.items.size;
      this.items.set(index, {
        callId: chunk.toolCall.id,
        name: this.options.normalizeToolName(chunk.toolCall.name),
        argumentsText: typeof chunk.toolCall.arguments === 'string'
          ? chunk.toolCall.arguments
          : JSON.stringify(chunk.toolCall.arguments ?? {}),
      });
      return;
    }
    const delta = chunk.toolCallDelta;
    if (!delta && !chunk.callId) return;
    const index = typeof delta?.index === 'number'
      ? delta.index
      : typeof chunk.index === 'number'
        ? chunk.index
        : 0;
    const item = this.items.get(index) ?? { argumentsText: '' };
    item.callId = delta?.id ?? chunk.callId ?? item.callId;
    item.name = delta?.name ? this.options.normalizeToolName(delta.name) : item.name;
    item.argumentsText += delta?.argumentsDelta ?? '';
    this.items.set(index, item);
  }

  toToolCalls(): NativeToolCallProposal[] {
    return [...this.items.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, item]) => ({
        callId: item.callId ?? `tool-call-${index}`,
        index,
        name: this.options.normalizeToolName(item.name ?? 'unknown'),
        arguments: this.options.parseArguments(item.argumentsText, item.name ?? 'unknown'),
        rawArguments: item.argumentsText,
      }));
  }
}

export function stripProviderPartFrames(content: string): string {
  return content.replace(/<deepcode-part>[\s\S]*?<\/deepcode-part>/g, '').trim();
}

function parseProviderPartFrame(raw: string): AgentStreamPartFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = objectRecord(parsed);
  if (!record || record.schemaVersion !== 'deepcode.agent.stream.part.v1') return null;
  const partKind = stringValue(record.partKind);
  if (!partKind || !isAgentStreamPartKind(partKind)) return null;
  return {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind,
    draftId: stringValue(record.draftId),
    frameId: stringValue(record.frameId),
    runId: stringValue(record.runId),
    targetPath: stringValue(record.targetPath),
    language: stringValue(record.language),
    toolId: stringValue(record.toolId),
    blockId: stringValue(record.blockId),
    actionId: stringValue(record.actionId),
    sequence: typeof record.sequence === 'number' ? record.sequence : undefined,
    chunk: typeof record.chunk === 'string' ? record.chunk : undefined,
    contentHash: stringValue(record.contentHash),
    summary: stringValue(record.summary),
    diagnostic: objectRecord(record.diagnostic) as AgentStreamPartFrame['diagnostic'],
    resumeHandle: stringValue(record.resumeHandle),
    metadata: objectRecord(record.metadata),
  };
}

function isAgentStreamPartKind(value: string): value is AgentStreamPartFrame['partKind'] {
  return value === 'thinkingDelta'
    || value === 'codeBlockChunk'
    || value === 'actionDraftChunk'
    || value === 'fileDone'
    || value === 'batchDone'
    || value === 'diagnostic';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
