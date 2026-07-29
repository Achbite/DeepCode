import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, SessionKernelHostRunnerV2,
  sha256Hash } from '../../dist/index.js';
import {
  createCorpusToolContext,
  decodedSemanticReply,
} from '../v2/harness.mjs';
const NOW = '2026-01-01T00:00:00.000Z';
const RUN_ID = 'run-1';
const WORKSPACE_REF = 'workspace-binding-session-smoke-v2';
const digest = (value) => `sha256:${value.repeat(64)}`;
const WORKSPACE_DIGEST = digest('d');
const REPLY_KINDS = Object.freeze({
  getToolContext: 'toolContext',
  submitToolIntent: 'toolIntentSubmission',
  queryFacts: 'kernelFactsProjected',
  advanceControlEpoch: 'controlEpochAdvanced',
  cancelInvocation: 'invocationCancelResult',
});
const LOADERS = { communication: () => import('./communication.mjs'),
  tools: () => import('./tools.mjs'),
  paths: () => import('./paths.mjs'),
  loop: () => import('./loop.mjs') };
export function assert(value, message) {
  if (!value) throw new Error(message);
}
export function answerOutput(text) {
  return {
    kind: 'answer',
    text,
    providerResult: { providerProfileId: 'session-smoke-provider',
      provider: 'controlled-smoke', model: 'session-v2-loop' },
  };
}
export function toolIntentOutput(toolId, argumentsValue, callId) {
  return {
    kind: 'toolIntent',
    source: { source: 'providerNative', callId, toolId,
      arguments: argumentsValue },
    providerResult: answerOutput('').providerResult,
  };
}
export function userInput(inputId, text) {
  return { inputId, opaqueInputRef: `opaque-${inputId}`, text,
    attachments: [], recordedAt: NOW };
}
export async function openSmokeSession(options) {
  const toolContext = createCorpusToolContext();
  const state = smokeState(options.kernelScripts);
  const kernel = scriptedKernelPort(state);
  const initialInput = userInput(
    options.inputId ?? 'input-session-smoke-v2',
    options.instruction
  );
  const runs = {
    async openRun(request) {
      state.runOpenRequests.push(clone(request));
      state.timeline.push(`runOpen:${request.inputId}`);
      return { kernel, controlEpoch: 1, toolContext };
    },
  };
  const provider = {
    async requestTurn(input) {
      state.timeline.push(`provider:${input.currentInput.inputId}`);
      return options.provider(input, state);
    },
  };
  const runner = await SessionKernelHostRunnerV2.open({
    workspaceBindingRef: WORKSPACE_REF,
    initialInput,
    sessionMemory: emptySessionMemory(),
    providerProfile: {
      schemaVersion: 'deepcode.host.provider-profile-bootstrap.v2',
      providerProfileId: 'session-smoke-provider',
      providerProfileRevisionDigest: digest('5'),
      contextWindowTokens: 100_000,
      maxOutputTokens: 4_096,
    },
  }, {
    runs,
    persistence: persistencePort(state),
    provider,
    projection: { async project(event) { project(state, event); },
      async flushPending() {} },
    clock: {
      now: () => NOW,
      async waitUntil(_instant, signal) {
        if (signal?.aborted) throw new Error('smoke wait aborted');
      },
    },
    ids: {
      nextRequestId: () => `request-smoke-${++state.requestSequence}`,
      nextProviderTurnId: () =>
        `provider-turn-smoke-${++state.providerSequence}`,
    },
  });
  return { runner, state, toolContext, workspaceBindingRef: WORKSPACE_REF };
}
function scriptedKernelPort(state) {
  const invoke = async (method, request) => {
    const { signal: _signal, ...serializable } = request;
    const recorded = clone(serializable);
    state.kernelRequests[method].push(recorded);
    state.timeline.push(`${method}:${timelineIdentity(method, recorded)}`);
    const queue = state.kernelScripts[method];
    if (!queue?.length) {
      if (method === 'queryFacts') {
        return decodedSemanticReply(
          recorded.requestId,
          REPLY_KINDS[method],
          emptyFactsPage(recorded)
        );
      }
      throw new Error(`unexpected ${method} call in bounded smoke`);
    }
    const script = queue.shift();
    const semantic = typeof script === 'function'
      ? await script(recorded)
      : script;
    return decodedSemanticReply(recorded.requestId,
      REPLY_KINDS[method], semantic);
  };
  return {
    run: { runId: RUN_ID, workspaceBindingDigest: WORKSPACE_DIGEST },
    getToolContext: (request) => invoke('getToolContext', request),
    async previewCapability() {
      throw new Error('scope preview is outside bounded smoke');
    },
    submitToolIntent: (request) => invoke('submitToolIntent', request),
    queryFacts: (request) => invoke('queryFacts', request),
    advanceControlEpoch: (request) => invoke('advanceControlEpoch', request),
    cancelInvocation: (request) => invoke('cancelInvocation', request),
  };
}
function persistencePort(state) {
  const none = async () => undefined;
  const noop = async () => {};
  return {
    loadCheckpoint: async () => clone(state.checkpoint),
    loadLatestPlan: none,
    loadPlanDecision: none,
    loadLatestInput: async () => clone(state.inputs.get(state.latestInputId)),
    loadInput: async (_runId, inputId) => clone(state.inputs.get(inputId)),
    loadPendingPublicRequests: async () => [],
    persistPlan: noop,
    persistPlanDecision: noop,
    persistPublicRequest: noop,
    async persistInput(input) {
      state.inputs.set(input.inputId, clone(input));
      state.latestInputId = input.inputId;
      state.timeline.push(`persistInput:${input.inputId}`);
    },
    async settlePublicRequest(_request, _digest, checkpoint, events) {
      state.checkpoint = clone(checkpoint);
      events.forEach((event) => project(state, event));
    },
    async persistCheckpoint(checkpoint) { state.checkpoint = clone(checkpoint); },
    async persistOperationResult(operationRequestId, result) {
      const resultDigest = sha256Hash(canonicalJson(result));
      return {
        recordId: `operation-result-${operationRequestId}`,
        recordDigest: sha256Hash(canonicalJson(
          { operationRequestId, resultDigest })),
        resultDigest,
      };
    },
  };
}
function smokeState(kernelScripts = {}) {
  const initialFactsQuery = (request) => emptyFactsPage(request);
  return {
    inputs: new Map(),
    projections: [],
    runOpenRequests: [],
    kernelRequests: Object.fromEntries(
      Object.keys(REPLY_KINDS).map((method) => [method, []])
    ),
    timeline: [],
    requestSequence: 0,
    providerSequence: 0,
    kernelScripts: Object.fromEntries(Object.keys(REPLY_KINDS).map(
      (method) => [
        method,
        [
          ...(method === 'queryFacts'
            ? [initialFactsQuery, initialFactsQuery]
            : []),
          ...(kernelScripts[method] ?? []),
        ],
      ]
    )),
  };
}
function emptyFactsPage(request) {
  return {
    requestedAfterLedgerSequence: request.afterLedgerSequence,
    snapshotHighWater: request.afterLedgerSequence,
    facts: [],
    hasMore: false,
    nextAfterLedgerSequence: request.afterLedgerSequence,
  };
}
function emptySessionMemory() {
  const value = {
    schemaVersion: 'deepcode.session.context-memory.v2',
    sessionId: 'session-smoke-v2',
    sourceEventVersion: 0,
    sourceEventCount: 0,
    omittedEntryCount: 0,
    truncated: false,
    entries: [],
  };
  return { ...value, contextDigest: sha256Hash(canonicalJson(value)) };
}
function timelineIdentity(method, request) {
  if (method === 'submitToolIntent') return request.intent.toolId;
  if (method === 'advanceControlEpoch') return request.inputId;
  if (method === 'cancelInvocation') {
    return request.target.data.invocationId;
  }
  if (method === 'queryFacts') return request.afterLedgerSequence;
  return request.requestId;
}
function project(state, event) {
  if (!state.projections.some(
    (item) => item.projectionId === event.projectionId
  )) {
    state.projections.push(clone(event));
  }
}
function clone(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}
async function main() {
  const group = process.argv[2] ?? '';
  const loader = LOADERS[group];
  if (!loader) throw new Error(`unknown registered smoke group: ${group}`);
  if (
    process.env.DEEPCODE_TEST_CONTROLLER !== '1'
    || process.env.DEEPCODE_TEST_SUITE_ID !== `session.smoke.${group}`
    || process.env.DEEPCODE_TEST_SMOKE_GROUP !== group
  ) {
    throw new Error('Use bash ./test.sh --profile smoke.');
  }
  const registered = JSON.parse(process.env.DEEPCODE_TEST_CASE_IDS ?? '');
  const { smokeCases } = await loader();
  assert(
    Array.isArray(registered)
      && JSON.stringify(registered)
        === JSON.stringify(smokeCases.map(({ id }) => id)),
    'registry/runtime smoke case mismatch'
  );
  for (const smokeCase of smokeCases) {
    try {
      await smokeCase.run();
      console.log(`[PASS] ${smokeCase.id}`);
    } catch (error) {
      throw new Error(`[FAIL] ${smokeCase.id}: ${error.message}`,
        { cause: error });
    }
  }
}
const invokedPath = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
