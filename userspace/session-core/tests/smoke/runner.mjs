import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
  SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
  SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA,
  SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
  SessionKernelHostRunnerV2,
  canonicalJson,
  providerWireToolNameV2,
  sha256Hash,
} from '../../dist/index.js';
import {
  createCorpusToolContext,
  decodedSemanticReply,
} from '../v2/harness.mjs';
const NOW = '2026-01-01T00:00:00.000Z';
const RUN_ID = 'run-1';
const WORKSPACE_REF = 'workspace-binding-session-smoke-v2';
const PROVIDER_PROFILE_ID = 'session-smoke-provider';
const PROVIDER_REASONING_TRANSPORT = 'openaiPlaintext';
const digest = (value) => `sha256:${value.repeat(64)}`;
const WORKSPACE_DIGEST = digest('d');
const REPLY_KINDS = Object.freeze({
  getToolContext: 'toolContext',
  previewCapabilityBatch: 'capabilityScopePreviewBatchResult',
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
    providerResult: { providerProfileId: PROVIDER_PROFILE_ID,
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
  const state = smokeState(options.kernelScripts, toolContext);
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
      const output = sealProviderOutput(
        input,
        await options.provider(input, state)
      );
      state.providerEvidence.set(
        input.providerTurnId,
        providerTurnEvidence(input, output)
      );
      return output;
    },
  };
  const runner = await SessionKernelHostRunnerV2.open({
    workspaceBindingRef: WORKSPACE_REF,
    initialInput,
    sessionMemory: emptySessionMemory(),
    providerProfile: {
      schemaVersion: 'deepcode.host.provider-profile-bootstrap.v2',
      providerProfileId: PROVIDER_PROFILE_ID,
      providerProfileRevisionDigest: digest('5'),
      reasoningTransport: PROVIDER_REASONING_TRANSPORT,
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
function sealProviderOutput(input, output) {
  if (output.kind === 'answer') {
    const items = [{ kind: 'text', phase: 'unknown', text: output.text }];
    const responseDigest = sha256Hash(canonicalJson({
      kind: 'answer',
      items,
    }));
    return {
      ...output,
      items,
      completion: providerCompletionReceipt(responseDigest, false),
    };
  }
  if (output.kind === 'toolIntent') {
    const source = output.source;
    const toolName = source.toolId;
    const items = [{
      kind: 'toolCall',
      source: 'providerNative',
      ordinal: 1,
      callId: source.callId,
      toolName,
      toolId: source.toolId,
      arguments: clone(source.arguments),
    }];
    const responseDigest = sha256Hash(canonicalJson({
      kind: 'toolIntent',
      items,
    }));
    return {
      kind: 'toolIntent',
      items,
      completion: providerCompletionReceipt(responseDigest, true),
      sources: [{
        source: 'providerNative',
        callId: source.callId,
        toolId: source.toolId,
        arguments: clone(source.arguments),
      }],
      receipt: {
        schemaVersion: SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
        providerTurnId: input.providerTurnId,
        responseDigest,
        callCount: 1,
        calls: [{
          ordinal: 1,
          callId: source.callId,
          toolName,
          toolId: source.toolId,
          argumentsDigest: sha256Hash(canonicalJson(source.arguments)),
        }],
        recordedAt: NOW,
      },
      providerResult: clone(output.providerResult),
    };
  }
  throw new Error(`unsupported controlled smoke Provider output: ${output.kind}`);
}
function providerCompletionReceipt(responseDigest, hasToolCalls) {
  const identity = canonicalJson({
    responseDigest,
    reasoningTransport: PROVIDER_REASONING_TRANSPORT,
    finishReason: hasToolCalls ? 'tool_calls' : 'stop',
  });
  return {
    schemaVersion: SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
    nativeCompletion: {
      providerKind: 'openaiCompatible',
      terminalSignal: '[DONE]',
      finishReason: hasToolCalls ? 'tool_calls' : 'stop',
    },
    reasoningPresent: true,
    reasoningTransport: PROVIDER_REASONING_TRANSPORT,
    reasoningDigest: sha256Hash(`reasoning:${identity}`),
    responseDigest,
    trace: {
      sealed: true,
      sealDigest: sha256Hash(`seal:${identity}`),
      terminalDigest: sha256Hash(`terminal:${identity}`),
      recordCount: 4,
    },
  };
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
    async previewCapabilityBatch() {
      throw new Error('scope preview batch is outside bounded smoke');
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
    loadProviderTurnEvidence: async (runId, providerTurnId) => {
      if (runId !== RUN_ID) throw new Error('smoke provider Run mismatch');
      const evidence = state.providerEvidence.get(providerTurnId);
      if (!evidence) {
        throw new Error(
          `missing durable smoke Provider evidence ${providerTurnId}`
        );
      }
      return clone(evidence);
    },
    loadToolContextSnapshot: async (runId, contextRef) => {
      if (
        runId !== RUN_ID
        || canonicalJson(contextRef)
          !== canonicalJson(toolContextRef(state.toolContext))
      ) {
        throw new Error('smoke ToolContext snapshot mismatch');
      }
      return clone(state.toolContext);
    },
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
      const record = {
        recordId: `operation-result-${operationRequestId}`,
        recordDigest: sha256Hash(canonicalJson(
          { operationRequestId, resultDigest })),
        resultDigest,
      };
      state.operationResults.set(operationRequestId, {
        resultDigest,
        result: clone(result),
      });
      return record;
    },
    loadOperationResult: async (operationRequestId) =>
      clone(state.operationResults.get(operationRequestId)),
  };
}
function smokeState(kernelScripts = {}, toolContext) {
  const initialFactsQuery = (request) => emptyFactsPage(request);
  return {
    inputs: new Map(),
    operationResults: new Map(),
    providerEvidence: new Map(),
    toolContext: clone(toolContext),
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

function providerTurnEvidence(input, output) {
  const authorityBinding = providerAuthorityBinding(input);
  const dispatchData = {
    schemaVersion: SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA,
    providerTurnId: input.providerTurnId,
    purpose: input.purpose,
    authorityBinding,
    requestDigest: sha256Hash(canonicalJson({
      providerTurnId: input.providerTurnId,
      purpose: input.purpose,
      authorityBinding,
      target: input.target,
      contextRef: input.toolContext.contextRef,
    })),
  };
  const dispatchRef = {
    recordId:
      `session-kernel-v3:${input.runId}:provider-turn:${input.providerTurnId}:dispatch`,
    recordDigest: sha256Hash(canonicalJson(dispatchData)),
  };
  const terminalData = {
    schemaVersion: SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
    providerTurnId: input.providerTurnId,
    dispatchRef,
    authorityBinding,
    terminalKind: 'completed',
    responseDigest: output.completion.responseDigest,
    completion: clone(output.completion),
    providerResult: clone(output.providerResult),
    traceRef: {
      terminalDigest: output.completion.trace.terminalDigest,
      sealDigest: output.completion.trace.sealDigest,
      recordCount: output.completion.trace.recordCount,
    },
    orderedItems: output.items.map((item, index) =>
      item.kind === 'text'
        ? { kind: 'text', phase: item.phase, text: item.text }
        : {
            kind: 'toolCall',
            index,
            callId: item.callId,
            name: providerWireToolNameV2(item.toolId),
            arguments: canonicalJson(item.arguments),
          }),
  };
  const terminalRef = {
    recordId:
      `session-kernel-v3:${input.runId}:provider-turn:${input.providerTurnId}:terminal`,
    recordDigest: sha256Hash(canonicalJson(terminalData)),
  };
  return {
    dispatch: { ref: dispatchRef, recordedAt: NOW, data: dispatchData },
    terminal: { ref: terminalRef, recordedAt: NOW, data: terminalData },
  };
}

function providerAuthorityBinding(input) {
  const currentInput = input.contextAssembly.receipt.trimming.sections.filter(
    (section) => section.section === 'currentInput'
  );
  assert(
    currentInput.length === 1,
    'smoke Provider evidence must bind one exact current input section'
  );
  return {
    runId: input.runId,
    inputId: input.currentInput.inputId,
    controlEpoch: input.controlEpoch,
    currentInputDigest: currentInput[0].digest,
    ...(input.plan ? { planRevision: input.plan.planRevision } : {}),
    ...(input.target.kind === 'finalAnswer'
      ? {
          reviewRevision: input.target.reviewRevision,
          snapshotHighWater: input.target.snapshotHighWater,
        }
      : {}),
    providerProfileId: input.providerProfile.providerProfileId,
    providerProfileRevisionDigest:
      input.providerProfile.providerProfileRevisionDigest,
  };
}

function toolContextRef(toolContext) {
  return {
    contextVersion: toolContext.contextVersion,
    catalogDigest: toolContext.catalogDigest,
    contextDigest: toolContext.contextDigest,
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
