import type {
  CommandJournalPort,
  CommandReply,
  ContextCompositionProjection,
  ConversationCommand,
  ConversationPort,
  ConversationReadQuery,
  ConversationReadResult,
  ConversationSessionStatus,
  SessionProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { SessionActor } from './actor.js';
import type { AgentComposition } from './plugins.js';
import { decodeConversationReadQuery, readConversation, readSessionEvents } from './conversationRead.js';
import { emptySessionState, recoverSession, reduceSession, type SessionState } from './reducer.js';

export interface SessionCompositionFactory {
  create(input: {
    sessionId: string;
    workspaceBindings: readonly WorkspaceBindingDisplay[];
  }): Promise<{
    composition: AgentComposition;
  }>;
}

export class SessionService implements ConversationPort {
  readonly #actors = new Map<string, Promise<SessionActor>>();
  readonly #statusStates = new Map<string, SessionState>();

  constructor(
    readonly journal: CommandJournalPort,
    readonly compositions: SessionCompositionFactory,
  ) {}

  async createSession(input: {
    sessionId: string;
    displayTitle: string;
    workspaceBindings: WorkspaceBindingDisplay[];
    profileId?: string;
  }): Promise<SessionProjection> {
    await this.journal.createSession({
      sessionId: input.sessionId,
      displayTitle: input.displayTitle,
      workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
      ...(input.profileId ? { profileId: input.profileId } : {}),
    });
    const actor = await this.actor(input.sessionId);
    return await actor.snapshot();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const actorPromise = this.#actors.get(sessionId);
    if (actorPromise) {
      let actor: SessionActor | undefined;
      try {
        actor = await actorPromise;
      } catch (error) {
        if (this.#actors.get(sessionId) === actorPromise) this.#actors.delete(sessionId);
        if (isActorOpenRollbackFailure(error)) throw error;
      }
      if (actor) {
        if (!actor.hasLoopFailure()) {
          const projection = await actor.snapshot();
          if (projection.run && ['running', 'waiting'].includes(projection.run.status)) {
            throw new Error('session_delete_active_run');
          }
        }
        await actor.dispose();
        if (this.#actors.get(sessionId) === actorPromise) this.#actors.delete(sessionId);
      }
    }
    await this.journal.deleteSession(sessionId);
    this.#statusStates.delete(sessionId);
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    return await (await this.actor(command.sessionId)).submit(command);
  }

  async snapshot(sessionId: string): Promise<SessionProjection> {
    return await (await this.actor(sessionId)).snapshot();
  }

  async statuses(sessionIds: readonly string[]): Promise<ConversationSessionStatus[]> {
    return await Promise.all(sessionIds.map(async (sessionId) => {
      // Reuse the canonical reducer and read only new events after the first read.
      // Sidebar reads must not open Actors or resume waiting/running conversations.
      let state = this.#statusStates.get(sessionId) ?? emptySessionState(sessionId);
      for await (const event of this.journal.read(sessionId, state.revision)) {
        state = reduceSession(state, event);
      }
      if (state.revision === 0) throw new Error('session_not_found');
      if (state.revision >= (this.#statusStates.get(sessionId)?.revision ?? 0)) {
        this.#statusStates.set(sessionId, state);
      }
      return {
        sessionId, revision: state.revision,
        run: state.run ? {
          runId: state.run.runId,
          status: state.run.status,
          ...(state.run.waitingReason ? { waitingReason: state.run.waitingReason } : {}),
        } : null,
      };
    }));
  }

  async contextComposition(sessionId: string, providerRequestId: string): Promise<ContextCompositionProjection> {
    const state = recoverSession(sessionId, await readSessionEvents(this.journal, sessionId));
    const receipt = state.contextCompositions.find((item) => item.providerRequestId === providerRequestId);
    if (!receipt) throw new Error('context_composition_not_found');
    return structuredClone(receipt);
  }

  async read(query: ConversationReadQuery): Promise<ConversationReadResult> {
    decodeConversationReadQuery(query);
    if (query.view === 'reasoning' && query.providerRequestId && this.#actors.has(query.sessionId)) {
      const actor = await this.#actors.get(query.sessionId)!;
      const projection = await actor.snapshot();
      if (projection.assistantDraft?.turnId === query.providerRequestId) {
        return { sessionId: query.sessionId, revision: projection.revision, view: 'reasoning',
          items: [actor.liveReasoning.read(query.providerRequestId)], nextBefore: null };
      }
    }
    return await readConversation(this.journal, query);
  }

  async dispose(): Promise<void> {
    const actorPromises = [...this.#actors.values()];
    this.#actors.clear();
    this.#statusStates.clear();
    const actorResults = await Promise.allSettled(actorPromises);
    const errors: unknown[] = actorResults.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    const disposeResults = await Promise.allSettled(
      actorResults.flatMap((result) => (
        result.status === 'fulfilled' ? [result.value.dispose()] : []
      )),
    );
    errors.push(...disposeResults.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    )));
    if (errors.length > 0) throw new AggregateError(errors, 'session_service_dispose_failed');
  }

  private async actor(sessionId: string): Promise<SessionActor> {
    let actor = this.#actors.get(sessionId);
    if (!actor) {
      actor = this.openActor(sessionId);
      this.#actors.set(sessionId, actor);
      void actor.catch(() => {
        if (this.#actors.get(sessionId) === actor) this.#actors.delete(sessionId);
      });
    }
    return await actor;
  }

  private async openActor(sessionId: string): Promise<SessionActor> {
    const events = await readSessionEvents(this.journal, sessionId);
    const first = events[0];
    if (!first) throw new Error('session_not_found');
    if (first.type !== 'session.created') throw new Error('session_creation_event_missing');
    const profileId = first.payload.profileId;
    const installed = await this.compositions.create({
      sessionId,
      workspaceBindings: first.payload.workspaceBindings.map((binding) => ({ ...binding })),
    });
    const actor = new SessionActor(sessionId, this.journal, installed.composition, {
      initialEvents: events,
      ...(profileId ? { profileId } : {}),
    });
    try {
      await actor.recover();
      return actor;
    } catch (error) {
      try {
        await actor.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'session_actor_open_rollback_failed',
        );
      }
      throw error;
    }
  }
}

function isActorOpenRollbackFailure(error: unknown): boolean {
  return error instanceof AggregateError && error.message === 'session_actor_open_rollback_failed';
}
