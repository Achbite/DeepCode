import { ProjectionEngine, type SessionProjectionCard } from './projection.js';
import { TranscriptChain, type TranscriptMessageEntry, type TranscriptStore } from './transcript.js';
import type { SessionIndexEntry } from './transcript.js';

export interface ResumeView {
  session: SessionIndexEntry;
  messages: TranscriptMessageEntry[];
  cards: SessionProjectionCard[];
}

export class ResumeLoader {
  constructor(
    private readonly transcriptStore: TranscriptStore,
    private readonly projector = new ProjectionEngine()
  ) {}

  async load(session: SessionIndexEntry, kernelEvents: unknown[] = []): Promise<ResumeView> {
    const entries = await this.transcriptStore.list(session.sessionId);
    return {
      session,
      messages: TranscriptChain.rebuild(entries, session.leafUuid),
      cards: this.projector.projectKernelEvents(kernelEvents, session.sessionId),
    };
  }
}
