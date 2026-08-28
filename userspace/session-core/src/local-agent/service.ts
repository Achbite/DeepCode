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
    profileId?: string;
  }): Promise<{
    composition: AgentComposition;
    profileId?: string;
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

  async dispose(): Promise<void> {
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
    const actor = new SessionActor(sessionId, this.journal, installed.composition, {
      ...(profileId ?? installed.profileId
        ? { profileId: profileId ?? installed.profileId }
        : {}),
    });
    await actor.recover();
    return actor;
  }
}

async function firstEvent(journal: CommandJournalPort, sessionId: string) {
  for await (const event of journal.read(sessionId)) return event;
  throw new Error('session_not_found');
}
