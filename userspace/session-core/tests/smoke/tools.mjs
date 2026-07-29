import {
  answerOutput, assert, openSmokeSession,
  toolIntentOutput,
} from './runner.mjs';
import { corpusFact, createFactsPage } from '../v2/harness.mjs';

export const smokeCases = [{
  id: 'tools.simple_tool_intent_roundtrip',
  run: simpleToolIntentRoundtrip,
}];

async function simpleToolIntentRoundtrip() {
  let providerTurn = 0;
  let facts;
  const smoke = await openSmokeSession({
    instruction: 'Read README.md once, then answer.',
    kernelScripts: {
      submitToolIntent: [(request) => {
        const identities = {
          runId: request.intent.runId,
          contextReadOperationId: request.intent.operationId,
        };
        const admitted = corpusFact('invocationContextReadAdmitted',
          { identities });
        facts = [
          admitted,
          corpusFact('effectContextReadObserved', { identities }),
          corpusFact('invocationContextReadCompleted', { identities }),
        ];
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
      queryFacts: [(request) => createFactsPage(facts, {
        requestId: request.requestId,
        requestedAfterLedgerSequence: request.afterLedgerSequence,
      })],
    },
    async provider(input) {
      providerTurn += 1;
      if (providerTurn === 1) {
        return toolIntentOutput('fs.read',
          { path: 'README.md' }, 'call-session-smoke-tool');
      }
      assert(input.kernelFacts.facts.some((fact) =>
        fact.domain === 'invocation' && fact.factKind === 'toolCompleted'
      ), 'the resumed Provider turn must receive the decoded terminal fact');
      return answerOutput('The ToolIntent fact woke the Loop.');
    },
  });
  const submitted = await smoke.runner.runInitialTurn();
  assert(submitted.kind === 'admitted',
    'the structural Provider call must become a ToolIntent submission');
  assert(smoke.state.kernelRequests.submitToolIntent.length === 1,
    'the Session Loop must submit the ToolIntent exactly once');
  const intent = smoke.state.kernelRequests.submitToolIntent[0].intent;
  assert(intent.toolId === 'fs.read'
      && intent.rawArguments.path === 'README.md',
  'ToolIntent must preserve the tool ID and raw arguments');
  assert(intent.authority.kind === 'contextRead',
    'the read call must retain the structural contextRead shape');
  assert(smoke.runner.snapshot().activeWait === undefined,
    'the reconciled terminal fact must release the invocation wait');
  const resumed = await smoke.runner.resumePlanning();
  assert(resumed.kind === 'answer'
      && resumed.text === 'The ToolIntent fact woke the Loop.',
  'the Session Loop must resume to the Provider answer');
  assert(smoke.state.kernelRequests.submitToolIntent.length === 1,
    'fact wake must not resubmit the ToolIntent');
  assert(smoke.runner.snapshot().activeWait === undefined,
    'the resumed Loop must remain clear of the completed invocation');
}
