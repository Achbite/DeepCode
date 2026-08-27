import type {
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  ConversationPort,
  ProjectionUpdate,
  SessionProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { PROJECTION_UPDATE_VERSION } from '@deepcode/protocol';
import { SessionActor } from './actor.js';
import type { AgentComposition } from './plugins.js';

export interface SessionCompositionFactory {
  create(input: {
    sessionId: string;
    workspaceBindings: readonly WorkspaceBindingDisplay[];
    profileId?: string;
  }): Promise<{
    composition: AgentComposition;
    profileId?: string;
  }>;
}

export class SessionService implements ConversationPort {
  readonly #actors = new Map<string, Promise<SessionActor>>();
  readonly #subscribers = new Map<string, Set<AsyncUpdateQueue>>();

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
      const actor = await actorPromise;
      const projection = await actor.snapshot();
      if (projection.run && ['running', 'waiting'].includes(projection.run.status)) {
        throw new Error('session_delete_active_run');
      }
      await actor.dispose();
      this.#actors.delete(sessionId);
    }
    await this.journal.deleteSession(sessionId);
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    return await (await this.actor(command.sessionId)).submit(command);
  }

  async snapshot(sessionId: string): Promise<SessionProjection> {
    return await (await this.actor(sessionId)).snapshot();
  }

  async *subscribe(
    sessionId: string,
    fromRevision: number,
  ): AsyncIterable<ProjectionUpdate> {
    const actor = await this.actor(sessionId);
    const snapshot = await actor.snapshot();
    yield {
      schemaVersion: PROJECTION_UPDATE_VERSION,
      type: 'snapshot',
      sessionId,
      revision: snapshot.revision,
      projection: snapshot,
    };
    const queue = new AsyncUpdateQueue();
    const subscribers = this.#subscribers.get(sessionId) ?? new Set<AsyncUpdateQueue>();
    subscribers.add(queue);
    this.#subscribers.set(sessionId, subscribers);
    try {
      for await (const update of queue) {
        fromRevision = Math.max(fromRevision, update.revision);
        yield update;
      }
    } finally {
      subscribers.delete(queue);
      queue.close();
      if (subscribers.size === 0) this.#subscribers.delete(sessionId);
    }
  }

  async dispose(): Promise<void> {
    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) subscriber.close();
    }
    this.#subscribers.clear();
    const actors = await Promise.all(this.#actors.values());
    await Promise.all(actors.map((actor) => actor.dispose()));
    this.#actors.clear();
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
      ...(profileId ? { profileId } : {}),
    });
    const actor = new SessionActor(
      sessionId,
      this.journal,
      installed.composition,
      {
        ...(profileId ?? installed.profileId
          ? { profileId: profileId ?? installed.profileId }
          : {}),
        onUpdate: (update) => this.publish(update),
      },
    );
    await actor.recover();
    return actor;
  }

  private publish(update: ProjectionUpdate): void {
    for (const subscriber of this.#subscribers.get(update.sessionId) ?? []) {
      subscriber.push(update);
    }
  }
}

async function firstEvent(journal: CommandJournalPort, sessionId: string) {
  for await (const event of journal.read(sessionId)) return event;
  throw new Error('session_not_found');
}

class AsyncUpdateQueue implements AsyncIterable<ProjectionUpdate> {
  readonly #items: ProjectionUpdate[] = [];
  readonly #waiters: Array<(result: IteratorResult<ProjectionUpdate>) => void> = [];
  #closed = false;

  push(update: ProjectionUpdate): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: update });
    else this.#items.push(update);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProjectionUpdate> {
    return {
      next: async () => {
        const item = this.#items.shift();
        if (item) return { done: false, value: item };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<ProjectionUpdate>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
