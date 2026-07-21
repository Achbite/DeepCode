import type { AgentTimelineDeliveryMode, AgentTimelineDelta } from './agent.js';

export const PROJECTION_DELIVERY_SCHEMA_VERSION = 'deepcode.session.projection-delivery.v1' as const;

export type ProjectionDeliveryStage =
  | 'session.provider_delta_received'
  | 'session.timeline_delta_projected'
  | 'session.timeline_delta_posted'
  | 'session.timeline_delta_post_failed'
  | 'daemon.timeline_delta_received'
  | 'daemon.timeline_delta_enqueued'
  | 'daemon.sse_delta_sent'
  | 'daemon.sse_terminal_sent'
  | 'gui.sse_stream_started'
  | 'gui.sse_stream_ended'
  | 'gui.sse_stream_failed'
  | 'gui.sse_delta_received'
  | 'gui.reducer_applied'
  | 'gui.reducer_gap'
  | 'gui.playback_released'
  | 'gui.render_committed'
  | 'gui.playback_settled'
  | 'diagnostic.dropped';

export interface ProjectionDeliveryRecord {
  schemaVersion: typeof PROJECTION_DELIVERY_SCHEMA_VERSION;
  stage: ProjectionDeliveryStage;
  at: string;
  sessionId: string;
  runId: string;
  turnId?: string;
  itemId?: string;
  blockId?: string;
  op?: AgentTimelineDelta['op'] | string;
  revision?: number;
  deltaSeq?: number;
  deliveryMode?: AgentTimelineDeliveryMode;
  charLength?: number;
  contentHash?: string;
  failureCode?: string;
  result?: 'accepted' | 'ignored' | 'gap' | 'failed' | 'sent' | 'settled';
  droppedCount?: number;
}

export interface AppendProjectionDeliveryRequest {
  entries: ProjectionDeliveryRecord[];
}
