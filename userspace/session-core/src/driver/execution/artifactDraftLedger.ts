import type {
  AgentEvent,
  KernelArtifactDraftLedgerFrame,
  KernelArtifactEditMatch,
} from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import { IntentSlotRegistry, type IntentSlot } from './intentSlot.js';
import type { TaskArtifactDirective, TaskArtifactInput } from './operationIntentCompiler.js';
import { PathIdentity } from '../context/pathIdentity.js';

export interface ArtifactSlotState {
  readonly slotId: string;
  readonly taskId: string;
  readonly operation: IntentSlot['operation'];
  readonly targetRef: string;
  readonly contentMode: IntentSlot['contentMode'];
  chunks: string[][];
  contentBytes: number;
  editMatch?: KernelArtifactEditMatch;
  completed: boolean;
}

export interface ArtifactDraftSnapshot {
  readonly draftId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly nextSequence: number;
  readonly maxTotalUtf8Bytes: number;
  readonly totalContentBytes: number;
  readonly terminal: boolean;
  readonly slots: ArtifactSlotState[];
}

export class ArtifactDraftError extends Error {
  readonly code:
    | 'artifact_chunk_invalid'
    | 'artifact_draft_incomplete'
    | 'artifact_draft_budget_exceeded'
    | 'artifact_edit_match_invalid';
  readonly slotId?: string;

  constructor(
    code: ArtifactDraftError['code'],
    message: string,
    slotId?: string
  ) {
    super(message);
    this.name = 'ArtifactDraftError';
    this.code = code;
    this.slotId = slotId;
  }
}

export class ArtifactDraftLease {
  private readonly slotIndex = new Map<string, ArtifactSlotState>();
  private nextSequence: number;
  private terminal: boolean;

  private constructor(
    readonly draftId: string,
    readonly runId: string,
    readonly sessionId: string,
    readonly taskId: string,
    slots: ArtifactSlotState[],
    private readonly maxTotalUtf8Bytes: number,
    nextSequence = 1,
    terminal = false
  ) {
    for (const slot of slots) this.slotIndex.set(slot.slotId, slot);
    this.nextSequence = nextSequence;
    this.terminal = terminal;
  }

  static create(input: {
    runId: string;
    sessionId: string;
    acceptedPlan: AcceptedTaskPlanContext | undefined;
    maxTotalUtf8Bytes: number;
    createId(prefix: string): string;
    slots?: IntentSlotRegistry;
  }): ArtifactDraftLease {
    const slots = (input.slots ?? new IntentSlotRegistry())
      .currentTaskSlots(input.acceptedPlan)
      .filter((slot) => slot.contentMode === 'full' || slot.contentMode === 'exactPatch')
      .map((slot): ArtifactSlotState => ({
        slotId: slot.slotId,
        taskId: slot.taskId,
        operation: slot.operation,
        targetRef: slot.targetRef,
        contentMode: slot.contentMode,
        chunks: [],
        contentBytes: 0,
        completed: false,
      }));
    const taskId = slots[0]?.taskId;
    if (!taskId || slots.length === 0) {
      throw new ArtifactDraftError(
        'artifact_draft_incomplete',
        'The current accepted task has no content-bearing IntentSlot.'
      );
    }
    return new ArtifactDraftLease(
      input.createId('artifact-draft'),
      input.runId,
      input.sessionId,
      taskId,
      slots,
      validDraftBudget(input.maxTotalUtf8Bytes)
    );
  }

  static restore(input: {
    events: readonly AgentEvent[];
    runId: string;
    sessionId: string;
    acceptedPlan: AcceptedTaskPlanContext | undefined;
    maxTotalUtf8Bytes?: number;
    createId(prefix: string): string;
  }): ArtifactDraftLease | undefined {
    const frames = draftFrames(input.events)
      .filter((frame) => frame.runId === input.runId && frame.sessionId === input.sessionId)
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    if (frames.length === 0) return undefined;
    const draftId = frames[frames.length - 1]?.draftId;
    if (!draftId) return undefined;
    const matching = frames.filter((frame) => frame.draftId === draftId);
    const slots = new IntentSlotRegistry()
      .currentTaskSlots(input.acceptedPlan)
      .filter((slot) => slot.contentMode === 'full' || slot.contentMode === 'exactPatch')
      .map((slot): ArtifactSlotState => ({
        slotId: slot.slotId,
        taskId: slot.taskId,
        operation: slot.operation,
        targetRef: slot.targetRef,
        contentMode: slot.contentMode,
        chunks: [],
        contentBytes: 0,
        completed: false,
      }));
    const taskId = slots[0]?.taskId;
    if (!taskId || slots.length === 0) return undefined;
    const lease = new ArtifactDraftLease(
      draftId,
      input.runId,
      input.sessionId,
      taskId,
      slots,
      validDraftBudget(input.maxTotalUtf8Bytes)
    );
    for (const frame of matching) lease.applyRestoredFrame(frame);
    return lease.terminal ? undefined : lease;
  }

  prepareAppendFrame(input: {
    slotId: string;
    contentLines: readonly string[];
    finalChunk: boolean;
    editMatch?: KernelArtifactEditMatch;
    resourcePackets: readonly ResourcePacket[];
    createId(prefix: string): string;
  }): KernelArtifactDraftLedgerFrame {
    this.assertOpen();
    const slot = this.slotIndex.get(input.slotId);
    if (!slot) {
      throw new ArtifactDraftError(
        'artifact_chunk_invalid',
        `Artifact chunk references unknown IntentSlot ${input.slotId}.`,
        input.slotId
      );
    }
    if (slot.completed) {
      throw new ArtifactDraftError(
        'artifact_chunk_invalid',
        `Artifact slot ${input.slotId} is already complete.`,
        input.slotId
      );
    }
    validateChunk(input.contentLines, input.slotId);
    const editMatch = validateSlotEditMatch(slot, input.editMatch, input.resourcePackets);
    const addedBytes = appendedContentBytes(slot, input.contentLines);
    const nextTotalBytes = this.totalContentBytes() + addedBytes;
    if (nextTotalBytes > this.maxTotalUtf8Bytes) {
      throw new ArtifactDraftError(
        'artifact_draft_budget_exceeded',
        `Artifact draft would use ${nextTotalBytes} UTF-8 bytes; maximum is ${this.maxTotalUtf8Bytes}.`,
        input.slotId
      );
    }
    const sequence = this.nextSequence;
    const contentLines = [...input.contentLines];
    const contentHash = artifactChunkHash(contentLines, editMatch);
    return {
      schemaVersion: 'deepcode.agent.artifact-draft.v1',
      partKind: 'artifactChunk',
      draftId: this.draftId,
      frameId: input.createId('artifact-frame'),
      runId: this.runId,
      sessionId: this.sessionId,
      taskId: this.taskId,
      slotId: input.slotId,
      sequence,
      contentLines,
      finalChunk: input.finalChunk,
      contentHash,
      ...(editMatch ? { editMatch } : {}),
      expectedSlotIds: [...this.slotIndex.keys()].sort(),
    };
  }

  prepareFinalizeFrame(summary: string, createId: (prefix: string) => string): KernelArtifactDraftLedgerFrame {
    this.assertComplete();
    const sequence = this.nextSequence;
    return {
      schemaVersion: 'deepcode.agent.artifact-draft.v1',
      partKind: 'batchDone',
      draftId: this.draftId,
      frameId: createId('artifact-finalize'),
      runId: this.runId,
      sessionId: this.sessionId,
      taskId: this.taskId,
      sequence,
      contentHash: artifactTextHash(summary),
      expectedSlotIds: [...this.slotIndex.keys()].sort(),
      metadata: { summary },
    };
  }

  prepareDiscardFrame(reason: string, createId: (prefix: string) => string): KernelArtifactDraftLedgerFrame | undefined {
    if (this.terminal) return undefined;
    const sequence = this.nextSequence;
    return {
      schemaVersion: 'deepcode.agent.artifact-draft.v1',
      partKind: 'diagnostic',
      draftId: this.draftId,
      frameId: createId('artifact-discard'),
      runId: this.runId,
      sessionId: this.sessionId,
      taskId: this.taskId,
      sequence,
      contentHash: artifactTextHash(reason),
      expectedSlotIds: [...this.slotIndex.keys()].sort(),
      metadata: { reason },
    };
  }

  directive(summary: string, narration: string | undefined): TaskArtifactDirective {
    this.assertComplete();
    return {
      summary,
      narration,
      artifacts: [...this.slotIndex.values()].map((slot): TaskArtifactInput => {
        const contentLines = slot.chunks.flatMap((chunk) => chunk);
        if (slot.operation === 'patchFile') {
          if (!slot.editMatch) {
            throw new ArtifactDraftError(
              'artifact_draft_incomplete',
              `IntentSlot ${slot.slotId} requires an explicit editMatch before fs.edit can be compiled.`,
              slot.slotId
            );
          }
          return {
            slotId: slot.slotId,
            editMatch: slot.editMatch,
            replacementLines: contentLines,
          };
        }
        return { slotId: slot.slotId, contentLines };
      }),
    };
  }

  snapshot(): ArtifactDraftSnapshot {
    return {
      draftId: this.draftId,
      runId: this.runId,
      sessionId: this.sessionId,
      taskId: this.taskId,
      nextSequence: this.nextSequence,
      maxTotalUtf8Bytes: this.maxTotalUtf8Bytes,
      totalContentBytes: this.totalContentBytes(),
      terminal: this.terminal,
      slots: [...this.slotIndex.values()].map((slot) => ({
        ...slot,
        chunks: slot.chunks.map((chunk) => [...chunk]),
      })),
    };
  }

  commitAcceptedFrame(frame: KernelArtifactDraftLedgerFrame): void {
    this.assertOpen();
    const acceptedPartKind: string = frame.partKind;
    if (frame.draftId !== this.draftId || frame.sequence !== this.nextSequence) {
      throw new ArtifactDraftError(
        'artifact_chunk_invalid',
        'Accepted artifact frame does not match the active draft sequence.'
      );
    }
    if (frame.partKind === 'artifactChunk') {
      const slot = frame.slotId ? this.slotIndex.get(frame.slotId) : undefined;
      if (!slot || !Array.isArray(frame.contentLines)) {
        throw new ArtifactDraftError(
          'artifact_chunk_invalid',
          'Accepted artifact chunk does not match an active IntentSlot.',
          frame.slotId
        );
      }
      const addedBytes = appendedContentBytes(slot, frame.contentLines);
      slot.chunks.push([...frame.contentLines]);
      slot.contentBytes += addedBytes;
      if (frame.editMatch) slot.editMatch = frame.editMatch;
      slot.completed = frame.finalChunk === true;
    } else if (frame.partKind === 'batchDone' || frame.partKind === 'diagnostic') {
      this.terminal = true;
    } else {
      throw new ArtifactDraftError(
        'artifact_chunk_invalid',
        `Unsupported accepted artifact frame kind ${acceptedPartKind}.`
      );
    }
    this.nextSequence += 1;
  }

  private assertComplete(): void {
    this.assertOpen();
    const incomplete = [...this.slotIndex.values()].filter((slot) => !slot.completed);
    if (incomplete.length > 0) {
      throw new ArtifactDraftError(
        'artifact_draft_incomplete',
        `Artifact draft has incomplete IntentSlot values: ${incomplete.map((slot) => slot.slotId).join(', ')}.`
      );
    }
  }

  private assertOpen(): void {
    if (this.terminal) {
      throw new ArtifactDraftError('artifact_chunk_invalid', 'Artifact draft is already terminal.');
    }
  }

  private totalContentBytes(): number {
    return [...this.slotIndex.values()].reduce((total, slot) => total + slot.contentBytes, 0);
  }

  private applyRestoredFrame(frame: KernelArtifactDraftLedgerFrame): void {
    if (frame.partKind === 'artifactChunk' && frame.slotId && Array.isArray(frame.contentLines)) {
      const slot = this.slotIndex.get(frame.slotId);
      if (!slot) return;
      const addedBytes = appendedContentBytes(slot, frame.contentLines);
      slot.chunks.push([...frame.contentLines]);
      slot.contentBytes += addedBytes;
      if (frame.editMatch) slot.editMatch = frame.editMatch;
      slot.completed = frame.finalChunk === true;
      if (this.totalContentBytes() > this.maxTotalUtf8Bytes) {
        throw new ArtifactDraftError(
          'artifact_draft_budget_exceeded',
          `Restored artifact draft exceeds ${this.maxTotalUtf8Bytes} UTF-8 bytes.`,
          frame.slotId
        );
      }
    }
    if (frame.partKind === 'batchDone' || frame.partKind === 'diagnostic') this.terminal = true;
    this.nextSequence = Math.max(this.nextSequence, (frame.sequence ?? 0) + 1);
  }
}

export function artifactChunkHash(
  lines: readonly string[],
  editMatch?: KernelArtifactEditMatch
): string {
  const linesJson = JSON.stringify(lines);
  return artifactTextHash(editMatch ? `${linesJson}\n${canonicalEditMatch(editMatch)}` : linesJson);
}

function artifactTextHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function validateChunk(lines: readonly string[], slotId: string): void {
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    throw new ArtifactDraftError('artifact_chunk_invalid', 'Artifact chunk contentLines must be a string array.', slotId);
  }
  if (lines.length === 0) {
    throw new ArtifactDraftError('artifact_chunk_invalid', 'Artifact chunk contentLines must not be empty.', slotId);
  }
}

function resourceTextEvidence(
  packets: readonly ResourcePacket[],
  targetRef: string
): { text: string; contentHash?: string; truncated: boolean; rangeComplete: boolean } | undefined {
  const paths = new PathIdentity();
  const target = paths.normalizePlanScopeIdentity(targetRef);
  for (const packet of [...packets].reverse()) {
    for (const item of packet.items) {
      if (item.status !== 'provided' && item.status !== 'resolved') continue;
      if (item.contentKind !== 'fileText' && item.contentKind !== 'text') continue;
      const candidatePath = item.path ?? item.absolutePath;
      if (!candidatePath) continue;
      const candidate = paths.normalizePlanScopeIdentity(candidatePath);
      if (candidate === target && typeof item.promptContent === 'string') {
        const record = item as typeof item & { contentHash?: string };
        return {
          text: item.promptContent,
          contentHash: record.contentHash,
          truncated: item.truncated === true,
          rangeComplete: item.rangeComplete !== false,
        };
      }
    }
  }
  return undefined;
}

function validateSlotEditMatch(
  slot: ArtifactSlotState,
  editMatch: KernelArtifactEditMatch | undefined,
  packets: readonly ResourcePacket[]
): KernelArtifactEditMatch | undefined {
  if (slot.contentMode !== 'exactPatch') {
    if (editMatch) {
      throw new ArtifactDraftError(
        'artifact_edit_match_invalid',
        `IntentSlot ${slot.slotId} does not accept editMatch.`,
        slot.slotId
      );
    }
    return undefined;
  }
  if (slot.chunks.length > 0) {
    if (editMatch) {
      throw new ArtifactDraftError(
        'artifact_edit_match_invalid',
        `IntentSlot ${slot.slotId} accepts editMatch only on its first logical chunk.`,
        slot.slotId
      );
    }
    return undefined;
  }
  if (!editMatch) {
    throw new ArtifactDraftError(
      'artifact_edit_match_invalid',
      `IntentSlot ${slot.slotId} requires editMatch on its first logical chunk.`,
      slot.slotId
    );
  }
  const evidence = resourceTextEvidence(packets, slot.targetRef);
  if (!evidence) {
    throw new ArtifactDraftError(
      'artifact_edit_match_invalid',
      `IntentSlot ${slot.slotId} requires fresh file text evidence for fs.edit.`,
      slot.slotId
    );
  }
  if (editMatch.kind === 'exactBlock') {
    assertUniqueEvidenceMatch(evidence.text, joinLines(editMatch.targetLines), slot.slotId);
    return editMatch;
  }
  if (editMatch.kind === 'contextBlock') {
    const before = editMatch.beforeLines.length ? `${joinLines(editMatch.beforeLines)}\n` : '';
    const target = joinLines(editMatch.targetLines);
    const after = editMatch.afterLines.length ? `\n${joinLines(editMatch.afterLines)}` : '';
    assertUniqueEvidenceMatch(evidence.text, `${before}${target}${after}`, slot.slotId);
    return editMatch;
  }
  if (editMatch.expectedFileHash) {
    if (!evidence.contentHash || evidence.contentHash !== editMatch.expectedFileHash) {
      throw new ArtifactDraftError(
        'artifact_edit_match_invalid',
        `IntentSlot ${slot.slotId} lineRange expectedFileHash does not match current ResourcePacket evidence.`,
        slot.slotId
      );
    }
    return editMatch;
  }
  if (!editMatch.expectedBeforeLines?.length || evidence.truncated || !evidence.rangeComplete) {
    throw new ArtifactDraftError(
      'artifact_edit_match_invalid',
      `IntentSlot ${slot.slotId} lineRange requires expectedFileHash or complete file evidence for expectedBeforeLines.`,
      slot.slotId
    );
  }
  const expectedBeforeText = lineRangeText(evidence.text, editMatch.startLine, editMatch.endLine);
  const comparableText = expectedBeforeText.endsWith('\n')
    ? expectedBeforeText.slice(0, -1)
    : expectedBeforeText;
  const actualLines = comparableText.split('\n');
  if (JSON.stringify(actualLines) !== JSON.stringify(editMatch.expectedBeforeLines)) {
    throw new ArtifactDraftError(
      'artifact_edit_match_invalid',
      `IntentSlot ${slot.slotId} lineRange expectedBeforeLines do not match current ResourcePacket evidence.`,
      slot.slotId
    );
  }
  return { ...editMatch, expectedBeforeText };
}

function assertUniqueEvidenceMatch(content: string, needle: string, slotId: string): void {
  if (!needle) {
    throw new ArtifactDraftError('artifact_edit_match_invalid', 'editMatch target text must not be empty.', slotId);
  }
  const first = content.indexOf(needle);
  if (first < 0 || content.indexOf(needle, first + needle.length) >= 0) {
    throw new ArtifactDraftError(
      'artifact_edit_match_invalid',
      `IntentSlot ${slotId} editMatch must occur exactly once in current ResourcePacket evidence.`,
      slotId
    );
  }
}

function appendedContentBytes(slot: ArtifactSlotState, lines: readonly string[]): number {
  const bytes = new TextEncoder().encode(joinLines(lines)).byteLength;
  return bytes + (slot.chunks.length > 0 ? 1 : 0);
}

function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

function validDraftBudget(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ArtifactDraftError('artifact_draft_incomplete', 'Kernel DraftAdmissionPolicy is unavailable or invalid.');
  }
  return value;
}

function canonicalEditMatch(editMatch: KernelArtifactEditMatch): string {
  if (editMatch.kind === 'exactBlock') {
    return `exactBlock\0${JSON.stringify(editMatch.targetLines)}`;
  }
  if (editMatch.kind === 'contextBlock') {
    return `contextBlock\0${JSON.stringify(editMatch.beforeLines)}\0${JSON.stringify(editMatch.targetLines)}\0${JSON.stringify(editMatch.afterLines)}`;
  }
  return `lineRange\0${editMatch.startLine}\0${editMatch.endLine}\0${editMatch.expectedFileHash ?? ''}\0${JSON.stringify(editMatch.expectedBeforeLines ?? [])}\0${JSON.stringify(editMatch.expectedBeforeText ?? '')}`;
}

function lineRangeText(content: string, startLine: number, endLine: number): string {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue;
    segments.push(content.slice(start, index + 1));
    start = index + 1;
  }
  if (start < content.length) segments.push(content.slice(start));
  return segments.slice(startLine - 1, endLine).join('');
}

function draftFrames(events: readonly AgentEvent[]): KernelArtifactDraftLedgerFrame[] {
  return events.flatMap((event): KernelArtifactDraftLedgerFrame[] => {
    const payload = objectRecord(event.payload);
    const eventRecord = objectRecord(event);
    const kernelEvent = objectRecord(payload?.kernelEvent)
      ?? objectRecord(eventRecord?.kernelEvent)
      ?? payload;
    const draft = objectRecord(kernelEvent?.draft);
    const frame = objectRecord(draft?.frame);
    return frame?.schemaVersion === 'deepcode.agent.artifact-draft.v1'
      ? [frame as unknown as KernelArtifactDraftLedgerFrame]
      : [];
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
