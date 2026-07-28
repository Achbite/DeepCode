import type {
  AgentConversationActivity,
  AgentEvent,
  AgentSessionResult,
  KernelCommandEnvelope,
  KernelReply,
  ProjectionDelta,
} from '@deepcode/protocol';
import { SessionDriverActiveTurnRuntimeAccessor } from './runFrame.js';
import {
  conversationPresentationLanguage,
  conversationPresentationLanguageBinding,
  type ConversationPresentationLanguage,
  type ConversationPresentationLanguageState,
  type ProjectionLanguageBinding,
} from './projection/conversationPresentationLanguage.js';

export interface AgentRunReactorState extends ConversationPresentationLanguageState {
  sessionId: string;
  runId: string;
  activeTurn?: {
    turnId: string;
    seq: number;
    stage: string;
  };
}

export interface AgentRunReactorPorts {
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  onProjectionDelta?: (delta: ProjectionDelta) => void | Promise<void>;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface AgentRunKernelProjection {
  projectionDeltaActivity(input: {
    runId: string;
    delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>;
    language: ConversationPresentationLanguage;
  }): AgentConversationActivity | undefined;
  indexKernelWorkUnitFacts(events: unknown[]): Map<string, unknown>;
  enrichKernelWorkUnitRecord(
    record: Record<string, unknown>,
    facts: Map<string, unknown>
  ): Record<string, unknown>;
  kernelEventActivity(
    record: Record<string, unknown>,
    activityId: string,
    fallbackRunId: string | undefined,
    language: ConversationPresentationLanguage
  ): AgentConversationActivity | undefined;
  kernelActivityDeltaType(record: Record<string, unknown>): ProjectionDelta['type'];
  projectionStatusForActivity(activity: AgentConversationActivity): ProjectionDelta['status'];
  kernelActivityChannel(activity: AgentConversationActivity): ProjectionDelta['channel'];
  projectKernelEvent(input: {
    sessionId: string;
    event: unknown;
    ts: string;
    id: string;
    language: ConversationPresentationLanguage;
  }): AgentEvent;
}

export interface AgentRunProgressProjection {
  traceEvent(input: {
    sessionId: string;
    kind: AgentEvent['kind'];
    summary: string;
    extra: Record<string, unknown>;
    ts: string;
    id: string;
  }): AgentEvent;
}

export interface AgentRunReactorInput {
  ports: AgentRunReactorPorts;
  kernelProjection: AgentRunKernelProjection;
  progressProjection: AgentRunProgressProjection;
  createError(code: string, message: string): Error;
  errorCode(error: unknown, fallback: string): string;
  errorMessage(error: unknown): string;
}

export class AgentRunReactor<State extends AgentRunReactorState = AgentRunReactorState> {
  constructor(private readonly input: AgentRunReactorInput) {}

  async emitProjectionDelta(
    state: State,
    delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>
  ): Promise<void> {
    if (!this.input.ports.onProjectionDelta) return;
    const activeTurn = new SessionDriverActiveTurnRuntimeAccessor(state).advance(
      delta.stage,
      (prefix) => this.id(prefix)
    );
    const activity = delta.activity ?? this.input.kernelProjection.projectionDeltaActivity({
      runId: state.runId,
      delta,
      language: conversationPresentationLanguage(state),
    });
    const presentationBinding = conversationPresentationLanguageBinding(state);
    const payload = projectionDeltaPayloadWithLanguageBinding(
      delta.payload,
      presentationBinding
    );
    await this.input.ports.onProjectionDelta({
      ...delta,
      activity,
      payload,
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: activeTurn.turnId,
      seq: activeTurn.seq,
    });
  }

  async emitKernelActivityDeltas(
    state: State,
    kernelEvents: unknown[],
    stage: string
  ): Promise<void> {
    const workUnitFacts = this.input.kernelProjection.indexKernelWorkUnitFacts(kernelEvents);
    for (let index = 0; index < kernelEvents.length; index += 1) {
      const record = objectRecord(kernelEvents[index]);
      if (!record) continue;
      const enriched = this.input.kernelProjection.enrichKernelWorkUnitRecord(record, workUnitFacts);
      const activity = this.input.kernelProjection.kernelEventActivity(
        enriched,
        `kernel-activity-${index}`,
        state.runId,
        conversationPresentationLanguage(state)
      );
      if (!activity) continue;
      await this.emitProjectionDelta(state, {
        type: this.input.kernelProjection.kernelActivityDeltaType(enriched),
        stage,
        status: this.input.kernelProjection.projectionStatusForActivity(activity),
        channel: this.input.kernelProjection.kernelActivityChannel(activity),
        source: 'kernel',
        itemId: activity.workUnitIds?.[0] ?? activity.actionIds?.[0] ?? activity.toolName ?? activity.activityId,
        targetPath: activity.targets?.[0],
        summary: activity.summary,
        activity,
        payload: {
          kernelEvent: enriched,
          activity,
        },
      });
    }
  }

  async kernel(request: KernelCommandEnvelope): Promise<KernelReply> {
    const reply = await this.input.ports.kernelCommand(request);
    if (!reply.ok) {
      throw this.input.createError(
        reply.error?.code ?? 'kernel_command_failed',
        reply.error?.message ?? 'Kernel command failed.'
      );
    }
    return reply;
  }

  async tryKernelAudit(
    sessionId: string,
    request: KernelCommandEnvelope,
    traceKind: AgentEvent['kind'],
    summary: string
  ): Promise<AgentSessionResult> {
    try {
      const reply = await this.input.ports.kernelCommand(request);
      if (reply.ok) {
        return this.appendProjectedKernelEvents(sessionId, reply, 'neutral');
      }
      return this.append(sessionId, [
        this.input.progressProjection.traceEvent({
          sessionId,
          kind: traceKind,
          summary,
          ts: this.ts(),
          id: this.id('kernel-audit-noop'),
          extra: {
            errorCode: reply.error?.code ?? 'kernel_audit_failed',
            errorMessage: reply.error?.message ?? 'Kernel audit command failed.',
          },
        }),
      ]);
    } catch (error) {
      return this.append(sessionId, [
        this.input.progressProjection.traceEvent({
          sessionId,
          kind: traceKind,
          summary,
          ts: this.ts(),
          id: this.id('kernel-audit-noop'),
          extra: {
            errorCode: this.input.errorCode(error, 'kernel_audit_failed'),
            errorMessage: this.input.errorMessage(error),
          },
        }),
      ]);
    }
  }

  async append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult> {
    return this.input.ports.appendEvents(sessionId, events);
  }

  async appendProjectedKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): Promise<AgentSessionResult> {
    const events = this.projectKernelEvents(sessionId, reply, language);
    if (events.length === 0) {
      return this.input.ports.appendEvents(sessionId, []);
    }
    return this.append(sessionId, events);
  }

  projectKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): AgentEvent[] {
    const workUnitFacts = this.input.kernelProjection.indexKernelWorkUnitFacts(reply.events ?? []);
    return (reply.events ?? []).map((event) => {
      const record = objectRecord(event);
      const projected = record ? this.input.kernelProjection.enrichKernelWorkUnitRecord(record, workUnitFacts) : event;
      const projectedEvent = this.input.kernelProjection.projectKernelEvent({
        sessionId,
        event: projected,
        ts: this.ts(),
        id: this.id('kernel'),
        language,
      });
      const payload = objectRecord(projectedEvent.payload);
      return payload
        ? {
            ...projectedEvent,
            payload: {
              ...payload,
              presentationLanguage: language,
            },
          }
        : projectedEvent;
    });
  }

  event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
    return {
      id: this.id(kind),
      sessionId,
      ts: this.ts(),
      kind,
      payload,
    };
  }

  id(prefix: string): string {
    return this.input.ports.createId?.(prefix) ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  ts(): string {
    return this.input.ports.now?.() ?? new Date().toISOString();
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function projectionDeltaPayloadWithLanguageBinding(
  value: unknown,
  binding: ProjectionLanguageBinding
): unknown {
  const payload = objectRecord(value);
  const explicitBinding = projectionLanguageBindingFromDeltaPayload(payload);
  const effectiveBinding = explicitBinding ?? binding;
  return {
    ...(payload ?? {}),
    ...(value !== undefined && !payload ? { rawPayload: value } : {}),
    presentationLanguage: effectiveBinding.language,
    languageRevision: effectiveBinding.revision,
    languageStatus: effectiveBinding.status,
    sourceTurnId: effectiveBinding.sourceTurnId,
  };
}

function projectionLanguageBindingFromDeltaPayload(
  payload: Record<string, unknown> | undefined
): ProjectionLanguageBinding | undefined {
  if (!payload) return undefined;
  const language = payload.presentationLanguage;
  const revision = payload.languageRevision;
  const status = payload.languageStatus;
  const sourceTurnId = payload.sourceTurnId;
  if (
    (language !== 'zh-CN' && language !== 'en-US' && language !== 'neutral')
    || !Number.isSafeInteger(revision)
    || (revision as number) < 1
    || (
      status !== 'pending'
      && status !== 'resolved'
      && status !== 'fallback'
      && status !== 'superseded'
      && status !== 'unavailable'
    )
    || typeof sourceTurnId !== 'string'
    || !sourceTurnId.trim()
  ) {
    return undefined;
  }
  const languageMatchesStatus = status === 'resolved' || status === 'fallback'
    ? language === 'zh-CN' || language === 'en-US'
    : language === 'neutral';
  return languageMatchesStatus
    ? {
        language,
        revision: revision as number,
        status,
        sourceTurnId: sourceTurnId.trim(),
      }
    : undefined;
}
