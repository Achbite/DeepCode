import type {
  AgentTimelineBlock,
  AgentTimelineDelta,
  ProjectionDeliveryRecord,
  ProjectionDeliveryStage,
} from '@deepcode/protocol';
import { PROJECTION_DELIVERY_SCHEMA_VERSION } from '@deepcode/protocol';

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MAX_RECORDS_PER_RUN = 10_000;

export type ProjectionDeliverySink = (
  entries: ProjectionDeliveryRecord[],
  signal: AbortSignal
) => Promise<void>;

export interface ProjectionDeliveryRecorderOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  maxRecords?: number;
  onError?: (error: unknown) => void;
}

export interface ProjectionDeliveryMetadata {
  stage: ProjectionDeliveryStage;
  sessionId: string;
  runId: string;
  turnId?: string;
  itemId?: string;
  blockId?: string;
  op?: string;
  revision?: number;
  deltaSeq?: number;
  deliveryMode?: ProjectionDeliveryRecord['deliveryMode'];
  charLength?: number;
  contentHash?: string;
  failureCode?: string;
  result?: ProjectionDeliveryRecord['result'];
  droppedCount?: number;
}

export class ProjectionDeliveryRecorder {
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRecords: number;
  private pending: ProjectionDeliveryRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private acceptedCount = 0;
  private droppedCount = 0;
  private closed = false;

  constructor(
    private readonly sink: ProjectionDeliverySink,
    private readonly identity: { sessionId: string; runId: string },
    private readonly options: ProjectionDeliveryRecorderOptions = {}
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS_PER_RUN);
  }

  record(metadata: Omit<ProjectionDeliveryMetadata, 'sessionId' | 'runId'>): void {
    if (this.closed) return;
    if (this.acceptedCount >= this.maxRecords) {
      this.droppedCount += 1;
      return;
    }
    this.acceptedCount += 1;
    this.pending.push(projectionDeliveryRecord({ ...this.identity, ...metadata }));
    if (this.pending.length >= this.batchSize) {
      this.clearFlushTimer();
      void this.flush();
      return;
    }
    this.armFlushTimer();
  }

  flush(): Promise<void> {
    this.clearFlushTimer();
    if (this.pending.length === 0) return this.flushChain;
    const entries = this.pending;
    this.pending = [];
    const controller = new AbortController();
    this.controllers.add(controller);
    this.flushChain = this.flushChain
      .then(() => this.sink(entries, controller.signal))
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.controllers.delete(controller));
    return this.flushChain;
  }

  async close(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearFlushTimer();
    if (this.droppedCount > 0) {
      this.pending.push(projectionDeliveryRecord({
        ...this.identity,
        stage: 'diagnostic.dropped',
        droppedCount: this.droppedCount,
        result: 'ignored',
      }));
    }
    const finalFlush = this.flush();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      finalFlush,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          for (const controller of this.controllers) controller.abort();
          resolve();
        }, Math.max(1, timeoutMs));
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  private armFlushTimer(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}

export function projectionDeliveryRecord(metadata: ProjectionDeliveryMetadata): ProjectionDeliveryRecord {
  return {
    schemaVersion: PROJECTION_DELIVERY_SCHEMA_VERSION,
    stage: metadata.stage,
    at: String(Date.now()),
    sessionId: metadata.sessionId,
    runId: metadata.runId,
    ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
    ...(metadata.itemId ? { itemId: metadata.itemId } : {}),
    ...(metadata.blockId ? { blockId: metadata.blockId } : {}),
    ...(metadata.op ? { op: metadata.op } : {}),
    ...(metadata.revision !== undefined ? { revision: metadata.revision } : {}),
    ...(metadata.deltaSeq !== undefined ? { deltaSeq: metadata.deltaSeq } : {}),
    ...(metadata.deliveryMode ? { deliveryMode: metadata.deliveryMode } : {}),
    ...(metadata.charLength !== undefined ? { charLength: metadata.charLength } : {}),
    ...(metadata.contentHash ? { contentHash: metadata.contentHash } : {}),
    ...(metadata.failureCode ? { failureCode: metadata.failureCode } : {}),
    ...(metadata.result ? { result: metadata.result } : {}),
    ...(metadata.droppedCount !== undefined ? { droppedCount: metadata.droppedCount } : {}),
  };
}

export function projectionDeliveryMetadataForTimelineDelta(
  stage: ProjectionDeliveryStage,
  delta: AgentTimelineDelta,
  result?: ProjectionDeliveryRecord['result']
): Omit<ProjectionDeliveryMetadata, 'sessionId' | 'runId'> {
  const block = timelineDeltaBlock(delta);
  const content = delta.op === 'text.append'
    ? delta.text
    : block?.bodyMarkdown ?? block?.summary ?? '';
  return {
    stage,
    turnId: delta.turnId,
    blockId: delta.blockId ?? block?.id,
    op: delta.op,
    revision: delta.revision ?? block?.revision,
    deltaSeq: delta.deltaSeq,
    deliveryMode: delta.op === 'block.started' ? delta.deliveryMode : block?.deliveryMode,
    ...projectionDeliveryContentMetadata(content),
    result,
  };
}

export function projectionDeliveryContentHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function projectionDeliveryContentMetadata(
  content: string
): Pick<ProjectionDeliveryMetadata, 'charLength' | 'contentHash'> {
  if (!content) return {};
  return {
    charLength: content.length,
    contentHash: projectionDeliveryContentHash(content),
  };
}

function timelineDeltaBlock(delta: AgentTimelineDelta): AgentTimelineBlock | undefined {
  if ('block' in delta && delta.block) return delta.block;
  return undefined;
}
