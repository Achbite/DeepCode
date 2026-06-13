import { routeEntryIntent } from './entryRouter.js';
import type { SessionDriverInput, SessionTurnFrame } from './types.js';

export class SessionDriver {
  handleUserTurn(input: SessionDriverInput): SessionTurnFrame {
    const entryIntent = routeEntryIntent(input);
    return {
      sessionId: input.sessionId,
      userTurn: {
        sessionId: input.sessionId,
        parentUuid: input.parentUuid,
        content: input.content,
        attachments: input.attachments ?? [],
      },
      entryIntent,
      driverRequest: input.driverRequest,
      stateContract: input.stateContract ?? input.driverRequest?.stateContract,
      projectionFrames: [
        {
          kind: 'session_turn_frame',
          entryIntent,
          sessionId: input.sessionId,
          driverRequestId: input.driverRequest?.id,
          stateId: input.stateContract?.stateId ?? input.driverRequest?.stateContract?.stateId,
        },
      ],
      status: input.driverRequest ? 'awaitingProvider' : 'awaitingKernel',
    };
  }
}
