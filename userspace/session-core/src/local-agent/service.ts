import type {
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  ConversationPort,
  SessionProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { SessionActor } from './actor.js';
import type { AgentComposition } from './plugins.js';

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
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    return await (await this.actor(command.sessionId)).submit(command);
  }

  async snapshot(sessionId: string): Promise<SessionProjection> {
    return await (await this.actor(sessionId)).snapshot();
  }

  async dispose(): Promise<void> {
    const actorPromises = [...this.#actors.values()];
    this.#actors.clear();
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
    const first = await firstEvent(this.journal, sessionId);
    if (first.type !== 'session.created') throw new Error('session_creation_event_missing');
    const profileId = first.payload.profileId;
    const installed = await this.compositions.create({
      sessionId,
      workspaceBindings: first.payload.workspaceBindings.map((binding) => ({ ...binding })),
    });
    const actor = new SessionActor(sessionId, this.journal, installed.composition, {
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

async function firstEvent(journal: CommandJournalPort, sessionId: string) {
  for await (const event of journal.read(sessionId)) return event;
  throw new Error('session_not_found');
}
