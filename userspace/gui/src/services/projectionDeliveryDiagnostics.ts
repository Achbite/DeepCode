import type {
  AgentTimelineBlock,
  AgentTimelineDelta,
  ProjectionDeliveryStage,
} from '@deepcode/protocol';
import {
  ProjectionDeliveryRecorder,
  projectionDeliveryContentMetadata,
  projectionDeliveryMetadataForTimelineDelta,
} from '@deepcode/session-core';
import { appendProjectionDelivery } from './runtimeAdapter';

const TERMINAL_GUARD_MS = 120_000;
const TERMINAL_SETTLE_CHECK_MS = 100;

interface GuiProjectionDeliveryRun {
  sessionId: string;
  runId: string;
  recorder: ProjectionDeliveryRecorder;
  blockIds: Set<string>;
  animatingBlockIds: Set<string>;
  terminal: boolean;
  playbackObservedAfterTerminal: boolean;
  settleCheckTimer?: number;
  closeTimer?: number;
}

class GuiProjectionDeliveryDiagnostics {
  private readonly runs = new Map<string, GuiProjectionDeliveryRun>();
  private readonly runKeyByBlock = new Map<string, string>();

  begin(sessionId: string, runId: string): void {
    const key = runKey(sessionId, runId);
    if (this.runs.has(key)) return;
    const recorder = new ProjectionDeliveryRecorder(async (entries, signal) => {
      const response = await appendProjectionDelivery(sessionId, entries, signal);
      if (!response.ok) {
        throw new Error(response.message ?? response.error ?? 'append projection delivery failed');
      }
    }, { sessionId, runId }, {
      onError: (error) => console.warn('projection delivery archive skipped', error),
    });
    this.runs.set(key, {
      sessionId,
      runId,
      recorder,
      blockIds: new Set(),
      animatingBlockIds: new Set(),
      terminal: false,
      playbackObservedAfterTerminal: false,
    });
  }

  recordDelta(
    stage: ProjectionDeliveryStage,
    delta: AgentTimelineDelta,
    result: 'accepted' | 'ignored' | 'gap'
  ): void {
    const context = this.contextForDelta(delta);
    if (!context) return;
    context.blockIds.add(delta.blockId);
    this.runKeyByBlock.set(blockKey(delta.sessionId, delta.blockId), runKey(delta.sessionId, delta.runId));
    context.recorder.record(projectionDeliveryMetadataForTimelineDelta(stage, delta, result));
  }

  recordBlock(
    stage: Extract<ProjectionDeliveryStage, 'gui.playback_released' | 'gui.render_committed' | 'gui.playback_settled'>,
    sessionId: string,
    block: AgentTimelineBlock
  ): void {
    const context = this.contextForBlock(sessionId, block.id);
    if (!context) return;
    context.recorder.record({
      stage,
      blockId: block.id,
      revision: block.revision,
      deliveryMode: block.deliveryMode,
      ...projectionDeliveryContentMetadata(block.bodyMarkdown ?? block.summary ?? ''),
      result: stage === 'gui.playback_settled' ? 'settled' : 'accepted',
    });
    if (context.terminal) {
      context.playbackObservedAfterTerminal = true;
      this.finishIfSettled(runKey(context.sessionId, context.runId), context);
    }
  }

  updateAnimatingBlocks(sessionId: string, blockIds: string[]): void {
    const byRun = new Map<string, Set<string>>();
    for (const blockId of blockIds) {
      const key = this.runKeyByBlock.get(blockKey(sessionId, blockId));
      if (!key) continue;
      const ids = byRun.get(key) ?? new Set<string>();
      ids.add(blockId);
      byRun.set(key, ids);
    }
    for (const [key, context] of this.runs) {
      if (context.sessionId !== sessionId) continue;
      context.animatingBlockIds = byRun.get(key) ?? new Set();
      if (context.terminal) context.playbackObservedAfterTerminal = true;
      this.finishIfSettled(key, context);
    }
  }

  markTerminal(sessionId: string, runId: string): void {
    const key = runKey(sessionId, runId);
    const context = this.runs.get(key);
    if (!context) return;
    context.terminal = true;
    void context.recorder.flush();
    context.settleCheckTimer = window.setTimeout(() => {
      context.playbackObservedAfterTerminal = true;
      this.finishIfSettled(key, context);
    }, TERMINAL_SETTLE_CHECK_MS);
    if (!this.runs.has(key) || context.closeTimer !== undefined) return;
    context.closeTimer = window.setTimeout(() => {
      void this.close(key, context);
    }, TERMINAL_GUARD_MS);
  }

  private contextForDelta(delta: AgentTimelineDelta): GuiProjectionDeliveryRun | undefined {
    return this.runs.get(runKey(delta.sessionId, delta.runId));
  }

  private contextForBlock(sessionId: string, blockId: string): GuiProjectionDeliveryRun | undefined {
    const key = this.runKeyByBlock.get(blockKey(sessionId, blockId));
    return key ? this.runs.get(key) : undefined;
  }

  private finishIfSettled(key: string, context: GuiProjectionDeliveryRun): void {
    if (
      !context.terminal
      || !context.playbackObservedAfterTerminal
      || context.animatingBlockIds.size > 0
    ) return;
    void this.close(key, context);
  }

  private async close(key: string, context: GuiProjectionDeliveryRun): Promise<void> {
    if (this.runs.get(key) !== context) return;
    this.runs.delete(key);
    if (context.settleCheckTimer !== undefined) window.clearTimeout(context.settleCheckTimer);
    if (context.closeTimer !== undefined) window.clearTimeout(context.closeTimer);
    for (const blockId of context.blockIds) {
      this.runKeyByBlock.delete(blockKey(context.sessionId, blockId));
    }
    await context.recorder.close();
  }
}

function runKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

function blockKey(sessionId: string, blockId: string): string {
  return `${sessionId}\u0000${blockId}`;
}

export const projectionDeliveryDiagnostics = new GuiProjectionDeliveryDiagnostics();
