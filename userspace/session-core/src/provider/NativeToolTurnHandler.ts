import type {
  LlmChatRequest,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../protocol/types.js';
import type {
  ResourceManifest,
  ResourcePacket,
} from '../context/types.js';
import type {
  NativeToolCoordinator,
  NativeToolReadLedgerEntry,
  NativeToolReadSignature,
} from './NativeToolCoordinator.js';
import type { NativeToolCallProposal } from './providerStreamParts.js';

export interface NativeToolTurnResult {
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

export interface NativeToolTurnHandlerState {
  sessionId: string;
  runId: string;
  userRequest: string;
  manifest: ResourceManifest;
  resourcePackets: ResourcePacket[];
  nativeToolReadLedger: Map<string, NativeToolReadLedgerEntry>;
  nativeToolDuplicateRepairAttempted: boolean;
}

export type NativeToolHandlingResult =
  | { kind: 'resume'; toolMessages: LlmChatRequest['messages'] }
  | { kind: 'proposal'; proposal: ProposalEnvelope };

export interface NativeToolTurnHandlerPorts<TState extends NativeToolTurnHandlerState, TPrompt, TTurn extends NativeToolTurnResult> {
  appendAssistantProgress(state: TState, narration: string): Promise<void>;
  emitCheckpoint(state: TState, round: number, toolCallCount: number): Promise<void>;
  repairSideEffect(state: TState, prompt: TPrompt, toolCall: NativeToolCallProposal, turn: TTurn): Promise<ProposalEnvelope>;
  tryParseTurnProposal(state: TState, turn: TTurn): ProposalEnvelope | null;
  repairDuplicate(
    state: TState,
    prompt: TPrompt,
    turn: TTurn,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry }>
  ): Promise<ProposalEnvelope>;
  emitDuplicateRead(state: TState, toolCall: NativeToolCallProposal, entry: NativeToolReadLedgerEntry): Promise<void>;
  duplicateToolMessage(toolCall: NativeToolCallProposal, entry: NativeToolReadLedgerEntry): LlmChatRequest['messages'][number];
  emitToolCallRunning(state: TState, toolCall: NativeToolCallProposal, round: number): Promise<void>;
  resolveReadToolCall(state: TState, toolCall: NativeToolCallProposal): Promise<ResourcePacket>;
  recordResolvedPacket(state: TState, signature: NativeToolReadSignature, packet: ResourcePacket): Promise<void>;
  emitResourceResolved(state: TState, toolCall: NativeToolCallProposal, packet: ResourcePacket, round: number): Promise<void>;
  packetToolMessage(toolCall: NativeToolCallProposal, packet: ResourcePacket): LlmChatRequest['messages'][number];
}

export interface NativeToolTurnHandlerInput<TState extends NativeToolTurnHandlerState, TPrompt, TTurn extends NativeToolTurnResult> {
  state: TState;
  prompt: TPrompt;
  turn: TTurn;
  round: number;
  ports: NativeToolTurnHandlerPorts<TState, TPrompt, TTurn>;
}

export class NativeToolTurnHandler {
  constructor(private readonly coordinator: NativeToolCoordinator) {}

  async handle<TState extends NativeToolTurnHandlerState, TPrompt, TTurn extends NativeToolTurnResult>(
    input: NativeToolTurnHandlerInput<TState, TPrompt, TTurn>
  ): Promise<NativeToolHandlingResult> {
    const { state, prompt, turn, round, ports } = input;
    const narration = turn.content.trim();
    if (narration) {
      await ports.appendAssistantProgress(state, narration);
    } else {
      await ports.emitCheckpoint(state, round, turn.toolCalls.length);
    }

    const unsupportedOrSideEffect = turn.toolCalls.find((toolCall) => !this.coordinator.canResolveReadOnly(toolCall));
    if (unsupportedOrSideEffect) {
      const repaired = await ports.repairSideEffect(state, prompt, unsupportedOrSideEffect, turn);
      return {
        kind: 'proposal',
        proposal: repaired,
      };
    }

    const repeatedReadCalls = turn.toolCalls
      .map((toolCall) => {
        const signature = this.coordinator.readSignature(toolCall);
        return { toolCall, signature, entry: state.nativeToolReadLedger.get(signature.key) };
      })
      .filter((item): item is { toolCall: NativeToolCallProposal; signature: NativeToolReadSignature; entry: NativeToolReadLedgerEntry } => Boolean(item.entry));
    if (repeatedReadCalls.length > 0) {
      const proposal = ports.tryParseTurnProposal(state, turn);
      if (proposal) {
        return { kind: 'proposal', proposal };
      }
    }
    if (repeatedReadCalls.some((item) => item.entry.repeatCount > 0)) {
      const repaired = await ports.repairDuplicate(state, prompt, turn, repeatedReadCalls);
      return {
        kind: 'proposal',
        proposal: repaired,
      };
    }

    const toolMessages: LlmChatRequest['messages'] = [];
    for (const toolCall of turn.toolCalls) {
      const signature = this.coordinator.readSignature(toolCall);
      const existing = state.nativeToolReadLedger.get(signature.key);
      if (existing) {
        existing.repeatCount += 1;
        await ports.emitDuplicateRead(state, toolCall, existing);
        toolMessages.push(ports.duplicateToolMessage(toolCall, existing));
        continue;
      }

      await ports.emitToolCallRunning(state, toolCall, round);
      const packet = await ports.resolveReadToolCall(state, toolCall);
      await ports.recordResolvedPacket(state, signature, packet);
      await ports.emitResourceResolved(state, toolCall, packet, round);
      toolMessages.push(ports.packetToolMessage(toolCall, packet));
    }
    return { kind: 'resume', toolMessages };
  }
}
