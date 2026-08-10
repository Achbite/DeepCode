import {
  answerOutput, assert, openSmokeSession,
  toolIntentOutput, userInput,
} from './runner.mjs';
import { corpusFact, createFactsPage } from '../v2/harness.mjs';

export const smokeCases = [{
  id: 'loop.new_input_interrupts_previous_turn',
  run: newInputInterruptsPreviousTurn,
}];

async function newInputInterruptsPreviousTurn() {
  const firstInstruction = 'Read one file, then wait for its invocation.';
  const secondInstruction = 'Supersede that invocation and answer this input.';
  let providerTurn = 0;
  let transitionFacts;
  let transitionHighWater;
  let cancellationFact;
  const smoke = await openSmokeSession({
    instruction: firstInstruction,
    kernelScripts: {
      submitToolIntent: [(request) => {
        const admitted = corpusFact('invocationContextReadAdmitted', {
          identities: {
            runId: request.intent.runId,
            contextReadOperationId: request.intent.operationId,
          },
        });
        transitionFacts = [admitted];
        return {
          kind: 'admitted',
          data: {
            runId: admitted.lineage.runId,
            operationId: admitted.lineage.operationId,
            acceptedControlEpoch: admitted.lineage.controlEpoch,
            invocationId: admitted.lineage.invocationId,
            attemptId: admitted.lineage.attemptId,
            effectiveDeadlineMs: admitted.details.effectiveDeadlineMs,
            admissionFactId: admitted.factId,
            admissionBatchHighWater: admitted.ledgerSequence,
          },
        };
      }],
      advanceControlEpoch: [(request) => {
        const admission = transitionFacts[0];
        const epochFact = corpusFact('controlEpochAdvanced', {
          ledgerSequence: admission.ledgerSequence + 1,
          runSequence: admission.runSequence + 1,
          identities: {
            runId: 'run-1',
            inputId: request.inputId,
            opaqueInputRef: request.opaqueInputRef,
          },
        });
        cancellationFact = corpusFact('controlCancellationRequested', {
          ledgerSequence: epochFact.ledgerSequence + 1,
          runSequence: epochFact.runSequence + 1,
          identities: {
            runId: 'run-1',
            cancellationInvocationId:
              transitionFacts[0].lineage.invocationId,
          },
        });
        transitionFacts.push(epochFact, cancellationFact);
        transitionHighWater = cancellationFact.ledgerSequence;
        return {
          runId: epochFact.lineage.runId,
          acceptedControlEpoch: epochFact.lineage.controlEpoch,
          epochFactId: epochFact.factId,
          supersededCapabilityCount: 0,
          cancellation: {
            kind: 'requested',
            data: {
              cancelRequestId:
                cancellationFact.details.identity.cancelRequestId,
              invocationId: cancellationFact.lineage.invocationId,
              cancellationFactId: cancellationFact.factId,
            },
          },
          commandBatchHighWater: cancellationFact.ledgerSequence,
        };
      }],
      queryFacts: [
        (request) => createFactsPage(transitionFacts, {
          requestId: request.requestId,
          requestedAfterLedgerSequence: request.afterLedgerSequence,
        }),
        (request) => createFactsPage(
          transitionFacts.filter(
            (fact) =>
              fact.ledgerSequence > request.afterLedgerSequence
          ),
          {
          requestId: request.requestId,
          requestedAfterLedgerSequence: request.afterLedgerSequence,
          snapshotHighWater: transitionHighWater,
          nextAfterLedgerSequence: transitionHighWater,
          }
        ),
      ],
    },
    async provider(input) {
      providerTurn += 1;
      if (providerTurn === 1) {
        assert(input.currentInput.text === firstInstruction,
          'the first Provider turn must bind the original input');
        return toolIntentOutput('fs.read',
          { path: 'README.md' }, 'call-session-smoke-pending');
      }
      assert(input.currentInput.text === secondInstruction,
        'the next Provider turn must bind the newest persisted input');
      return answerOutput('The newer Session input won the Loop fence.');
    },
  });
  const admitted = await smoke.runner.runInitialTurn();
  assert(admitted.kind === 'admitted'
      && admitted.invocationId === 'invocation-golden-context-read-1',
  'the first turn must leave one invocation active');
  assert(smoke.runner.snapshot().activeWait?.kind === 'invocation'
      && smoke.runner.snapshot().activeWait.invocationId === admitted.invocationId,
  'the Loop must retain the non-terminal invocation wait');

  const second = userInput('input-session-smoke-newer', secondInstruction);
  const generation = await smoke.runner.persistUserInputBeforeFence(second);
  assert(smoke.runner.isUserInputFenceCurrent(generation),
    'persisting the input must establish the local Loop fence');
  smoke.state.timeline.push(`localFence:${second.inputId}`);
  await smoke.runner.applyFencedUserInput(second, generation);
  const current = await smoke.runner.runUserInputProviderTurn();
  assert(current.kind === 'answer'
      && current.text === 'The newer Session input won the Loop fence.',
  'the new input must reach the next Provider turn');

  const index = (value) => smoke.state.timeline.indexOf(value);
  const persisted = index(`persistInput:${second.inputId}`);
  const fence = index(`localFence:${second.inputId}`);
  const epoch = index(`advanceControlEpoch:${second.inputId}`);
  const facts = smoke.state.timeline.findIndex(
    (entry, position) => position > epoch && entry.startsWith('queryFacts:')
  );
  const provider = index(`provider:${second.inputId}`);
  assert(persisted >= 0 && fence > persisted && epoch > fence
      && facts > epoch && provider > facts,
  'new input must follow persist → epoch/cancel → facts → Provider');
  assert(smoke.state.kernelRequests.advanceControlEpoch.length === 1
      && smoke.state.kernelRequests.advanceControlEpoch[0].inputId
        === second.inputId,
  'the input fence must advance its control epoch');
  assert(cancellationFact.lineage.invocationId === admitted.invocationId
      && smoke.state.kernelRequests.cancelInvocation.length === 0,
  'the epoch reply must identify cancellation of the prior invocation');
}
