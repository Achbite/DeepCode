import type {
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  NewSessionEvent,
  SessionCreationInput,
  SessionEvent,
  StoredCommand,
} from '@deepcode/protocol';
import {
  SESSION_EVENT_VERSION,
} from '@deepcode/protocol';

/** 仅用于单元测试和嵌入式演示；产品路径使用 SQLite Journal 适配器。 */
export class InMemoryCommandJournal implements CommandJournalPort {
  readonly #events = new Map<string, SessionEvent[]>();
  readonly #commands = new Map<string, StoredCommand>();
  #tail = Promise.resolve();
  #eventCounter = 0;

  async createSession(input: SessionCreationInput): Promise<SessionEvent> {
    return await this.serial(async () => {
      if (this.#events.has(input.sessionId)) throw new Error('session_already_exists');
      this.#events.set(input.sessionId, []);
      return this.appendNow({
        type: 'session.created',
        sessionId: input.sessionId,
        payload: {
          displayTitle: input.displayTitle,
          workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
          ...(input.profileId ? { profileId: input.profileId } : {}),
        },
      });
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.serial(async () => {
      if (!this.#events.delete(sessionId)) throw new Error('session_not_found');
      for (const key of [...this.#commands.keys()]) {
        if (key.startsWith(`${sessionId}\u0000`)) this.#commands.delete(key);
      }
    });
  }

  async append(event: NewSessionEvent): Promise<SessionEvent> {
    return await this.serial(async () => this.appendNow(event));
  }

  async appendBatch(events: readonly NewSessionEvent[]): Promise<SessionEvent[]> {
    return await this.serial(async () => events.map((event) => this.appendNow(event)));
  }

  async *read(sessionId: string, afterSequence = 0): AsyncIterable<SessionEvent> {
    const events = this.#events.get(sessionId);
    if (!events) throw new Error('session_not_found');
    for (const event of events) {
      if (event.sequence > afterSequence) yield structuredClone(event);
    }
  }

  async readCommand(sessionId: string, commandId: string): Promise<StoredCommand | null> {
    const stored = this.#commands.get(commandKey(sessionId, commandId));
    return stored ? structuredClone(stored) : null;
  }

  async commitCommand(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<CommandReply> {
    return await this.serial(async () => {
      const key = commandKey(command.sessionId, command.commandId);
      if (this.#commands.has(key)) throw new Error('command_already_recorded');
      for (const event of events) this.appendNow(event);
      const revision = this.#events.get(command.sessionId)?.at(-1)?.sequence ?? 0;
      const admitted = { ...reply, revision };
      this.#commands.set(key, {
        command: structuredClone(command),
        reply: structuredClone(admitted),
      });
      return admitted;
    });
  }

  private appendNow(event: NewSessionEvent): SessionEvent {
    const events = this.#events.get(event.sessionId);
    if (!events) throw new Error('session_not_found');
    const sequence = events.length + 1;
    this.#eventCounter += 1;
    const committed = {
      ...event,
      schemaVersion: SESSION_EVENT_VERSION,
      eventId: `event:${this.#eventCounter}`,
      sequence,
      occurredAt: new Date().toISOString(),
    } as SessionEvent;
    events.push(committed);
    return structuredClone(committed);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function commandKey(sessionId: string, commandId: string): string {
  return `${sessionId}\u0000${commandId}`;
}
