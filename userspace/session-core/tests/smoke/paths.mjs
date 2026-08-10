import {
  answerOutput, assert, openSmokeSession, toolIntentOutput,
} from './runner.mjs';
import { corpusFact, createFactsPage } from '../v2/harness.mjs';

export const smokeCases = [{
  id: 'paths.canonical_path_error_is_structured',
  run: pathErrorIsStructured,
}];

async function pathErrorIsStructured() {
  let providerTurn = 0;
  let rejectionFact;
  let rejectionGuidance;
  const smoke = await openSmokeSession({
    instruction: 'Submit the path and preserve a structured Kernel error.',
    kernelScripts: {
      submitToolIntent: [(request) => {
        rejectionFact = corpusFact(
          'controlCommandRecordedRejectedInvalidPathToolIntent',
          { identities: {
            runId: request.intent.runId,
            invalidPathOperationId: request.intent.operationId,
            invalidPathRequestId: request.requestId,
          } }
        );
        return rejectionFact.details.result.data.reply;
      }],
      queryFacts: [(request) => createFactsPage([rejectionFact], {
        requestId: request.requestId,
        requestedAfterLedgerSequence: request.afterLedgerSequence,
      })],
    },
    async provider(input) {
      providerTurn += 1;
      if (providerTurn === 1) {
        return toolIntentOutput('fs.read',
          { path: '../outside-workspace.txt' }, 'call-session-smoke-path');
      }
      assert(input.guidance.includes(rejectionGuidance),
        'structured Kernel guidance must reach the next Provider turn');
      return answerOutput('Kernel rejected the path; no file result was invented.');
    },
  });
  const rejected = await smoke.runner.runInitialTurn();
  rejectionGuidance = rejected.guidance;
  assert(rejected.kind === 'rejected'
      && rejectionGuidance.includes('workspace-relative path'),
  'the Kernel response must remain a structured ToolIntent rejection');
  assert(smoke.state.kernelRequests.submitToolIntent.length === 1
      && smoke.state.kernelRequests.submitToolIntent[0].intent.rawArguments.path
        === '../outside-workspace.txt',
  'the submitted logical path must remain visible at the semantic port');
  const replanned = await smoke.runner.resumePlanning();
  assert(replanned.kind === 'answer'
      && replanned.text === 'Kernel rejected the path; no file result was invented.',
  'the Loop must carry structured guidance into the next response');
  assert(smoke.state.kernelRequests.submitToolIntent.length === 1,
    'the next Provider turn must not replay the rejected call');
}
