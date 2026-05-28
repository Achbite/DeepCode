import { ProjectionEngine } from './projection.js';
import { appendUserMessageBeforeKernelDispatch, type TranscriptStore } from './transcript.js';

export interface SessionSubmitInput {
  sessionId: string;
  parentUuid?: string;
  content: string;
}

export interface SessionSubmitResult {
  userMessageUuid: string;
  cards: ReturnType<ProjectionEngine['projectKernelEvents']>;
}

export class SessionController {
  constructor(
    private readonly transcriptStore: TranscriptStore,
    private readonly dispatchKernel: (input: SessionSubmitInput) => Promise<unknown[]>,
    private readonly projector = new ProjectionEngine()
  ) {}

  async submit(input: SessionSubmitInput): Promise<SessionSubmitResult> {
    const userMessage = await appendUserMessageBeforeKernelDispatch(this.transcriptStore, input);
    const events = await this.dispatchKernel(input);
    return {
      userMessageUuid: userMessage.uuid,
      cards: this.projector.projectKernelEvents(events, input.sessionId),
    };
  }
}
