import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KERNEL_ABI_V2_VERSION, decodeKernelCommandResponseEnvelopeV2,
  decodeKernelFactProjectionV2, decodeToolContextBundleV2,
} from '@deepcode/protocol';
import {
  SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
  SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA,
  SESSION_KERNEL_PERSISTENCE_V3_SCHEMA,
  SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA,
  SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
  SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA,
  SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
  SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA,
  SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
  SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA,
  SessionKernelAppendOnlyPersistenceV3,
  SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
  SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
  SessionKernelLoopV2,
  SessionKernelProviderTransportError,
  adaptSessionKernelProviderBackendOutputV2,
  buildSessionPlanConfirmationAuthorityV2,
  canonicalJson,
  checkpointSessionKernelStateV2,
  prepareSessionKernelFactReplayV3,
  providerWireToolNameV2,
  recordSessionPlanConfirmationAuthorityV2,
  sha256Hash,
} from '../../dist/index.js';
export { assert };
export const NOW = '2026-07-29T00:00:00.000Z';
export const RUN_ID = 'run-session-v2-contract';
export const WORKSPACE_DIGEST = `sha256:${'d'.repeat(64)}`;
export const RUN_CAPABILITY_SECRET = 'run-capability-secret-must-never-reach-session-context';
export const DECISION_CAPABILITY_SECRET = 'decision-capability-secret-must-never-reach-session-context';
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const GOLDEN_FIXTURE = JSON.parse(readFileSync(new URL(
  '../../../../fixtures/kernel-session-v2/wire-golden.json',
  import.meta.url
), 'utf8'));
const KERNEL_FACT_CORPUS = GOLDEN_FIXTURE.kernelFactCorpus;
const KERNEL_CAPABILITY_PREVIEWS = GOLDEN_FIXTURE.kernelCapabilityPreviews;
if (!KERNEL_FACT_CORPUS || typeof KERNEL_FACT_CORPUS !== 'object') {
  throw new Error('Kernel wire golden fixture has no fact corpus.');
}
if (!KERNEL_CAPABILITY_PREVIEWS
  || typeof KERNEL_CAPABILITY_PREVIEWS !== 'object') {
  throw new Error('Kernel wire golden fixture has no capability previews.');
}
export const createCorpusToolContext = () => decodeToolContextBundleV2(clone(GOLDEN_FIXTURE.kernelToolContext));
export const createMutationToolContext = () => decodeToolContextBundleV2(clone(GOLDEN_FIXTURE.kernelMutationToolContext));
const CORPUS_IDENTITY_TOKENS = Object.freeze({
  runId: 'run-1', planRevision: 'plan-revision-golden-1',
  planActionId: 'plan-action-golden-1', operationId: 'operation-golden-output',
  plannedOperationId: 'planned-operation-golden-output',
  deniedPlanRevision: 'plan-revision-golden-deny-1',
  deniedPlanActionId: 'plan-action-golden-deny-1',
  expandedOperationId: 'operation-c4cbe96134b04cf4963b4f50d5672870167c9dd3826e9aca6a3ce3a468367e64',
  deniedOperationId: 'operation-9bf7e05374580c4630967e5c9a584a26f5884d63df3fba7ff17338c2da906bb6',
  leaseId: 'lease-golden-1', deniedLeaseId: 'lease-golden-deny-1',
  issuedScopeDigest: KERNEL_CAPABILITY_PREVIEWS.corpusNormal.scopeDigest,
  expandedScopeDigest: KERNEL_CAPABILITY_PREVIEWS.corpusExpandedAllow.scopeDigest,
  deniedExpandedScopeDigest: KERNEL_CAPABILITY_PREVIEWS.corpusExpandedDeny.scopeDigest,
  invocationId: 'invocation-golden-output-1', attemptId: 'attempt-golden-output-1',
  effectId: 'effect-golden-output-1', resourceId: 'resource-golden-output',
  expandedInvocationId: 'invocation-golden-expanded-1',
  expandedAttemptId: 'attempt-golden-expanded-2', expandedEffectId: 'effect-golden-expanded-1',
  expandedResourceId: 'resource-golden-expanded',
  deniedExpandedInvocationId: 'invocation-golden-expanded-deny-1',
  indeterminateInvocationId: 'invocation-golden-indeterminate-1',
  indeterminateOperationId: 'operation-golden-indeterminate',
  indeterminateAttemptId: 'attempt-golden-indeterminate-1', indeterminateEffectId: 'effect-golden-indeterminate-1',
  previewId: 'preview-golden-expanded-allow-1', deniedPreviewId: 'preview-golden-expanded-deny-1',
  inputId: 'input-golden-2', opaqueInputRef: 'session-input:golden:2',
  cancelRequestId: 'cancel-golden-1',
  epochAdvancedFactId: 'fact-epoch-advanced-golden-1',
  capabilityAwaitingFactId: 'fact-capability-awaiting-golden-1',
  expansionAllowedFactId: 'fact-expansion-allowed-golden-1',
  admittedFactId: 'fact-tool-intent-admitted-golden-1', observedFactId: 'fact-effect-observed-corpus-golden-1',
  expandedObservedFactId: 'fact-expanded-effect-observed-golden-1',
  completedFactId: 'fact-tool-completed-corpus-golden-1', cleanupScheduledFactId: 'fact-cleanup-scheduled-golden-1',
  contextReadOperationId: 'operation-golden-context-read',
  contextReadInvocationId: 'invocation-golden-context-read-1',
  contextReadAttemptId: 'attempt-golden-context-read-1', contextReadEffectId: 'effect-golden-context-read-1',
  invalidPathOperationId: 'operation-golden-invalid-path', invalidPathRequestId: 'request-golden-invalid-path-tool-intent-1',
  cancellationInvocationId: 'invocation-golden-active-at-epoch-1',
});
const REPLY_KINDS = Object.freeze({
  getToolContext: 'toolContext',
  previewCapabilityBatch: 'capabilityScopePreviewBatchResult',
  submitToolIntent: 'toolIntentSubmission',
  queryFacts: 'kernelFactsProjected',
  advanceControlEpoch: 'controlEpochAdvanced',
  cancelInvocation: 'invocationCancelResult',
});
export function createToolContext(overrides = {}) {
  if (Object.keys(overrides).length !== 0)
    throw new Error('ToolContext test fixtures are immutable Rust golden bundles.');
  return createMutationToolContext();
}
export function toolContextRef(toolContext) {
  return {
    contextVersion: toolContext.contextVersion,
    catalogDigest: toolContext.catalogDigest,
    contextDigest: toolContext.contextDigest,
  };
}
export function createInput(overrides = {}) {
  return {
    inputId: overrides.inputId ?? 'input-initial',
    opaqueInputRef: overrides.opaqueInputRef ?? 'session-input:initial',
    text: overrides.text ?? 'Inspect the current workspace safely.',
    attachments: clone(overrides.attachments ?? []),
    attachmentContexts: clone(overrides.attachmentContexts ?? []),
    recordedAt: overrides.recordedAt ?? NOW,
  };
}
function createSessionMemory(sessionId = 'session-v2-contract') {
  const value = {
    schemaVersion: 'deepcode.session.context-memory.v2',
    sessionId,
    sourceEventVersion: 0,
    sourceEventCount: 0,
    omittedEntryCount: 0,
    truncated: false,
    entries: [],
  };
  return {
    ...value,
    contextDigest: sha256Hash(canonicalJson(value)),
  };
}
function createProviderProfile() {
  return {
    schemaVersion: 'deepcode.host.provider-profile-bootstrap.v2',
    providerProfileId: 'provider-profile-v2-contract',
    providerProfileRevisionDigest: `sha256:${'6'.repeat(64)}`,
    reasoningTransport: 'openaiPlaintext',
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
  };
}
export function createInitialState(overrides = {}) {
  return {
    runId: overrides.runId ?? RUN_ID,
    workspaceBindingDigest: overrides.workspaceBindingDigest
      ?? WORKSPACE_DIGEST,
    controlEpoch: overrides.controlEpoch ?? 1,
    initialInput: clone(overrides.initialInput ?? createInput()),
    toolContext: clone(overrides.toolContext ?? createToolContext()),
    sessionMemory: clone(overrides.sessionMemory ?? createSessionMemory()),
    providerProfile: clone(overrides.providerProfile ?? createProviderProfile()),
  };
}
export function createPlan(overrides = {}) {
  const planRevision = overrides.planRevision ?? 'plan-revision-1';
  const action = {
    taskId: overrides.taskId ?? 'task-write-output',
    manifest: {
      planRevision,
      planActionId: overrides.planActionId ?? 'plan-action-write-output',
      operationId: overrides.operationId ?? 'planned-operation-write-output',
      toolId: overrides.toolId ?? 'fs.write',
      scopeIntent: clone(overrides.scopeIntent ?? {
        kind: 'resourceScope',
        data: {
          requestedResources: [{
            kind: 'workspacePath',
            data: { path: 'output.txt', access: 'write' },
          }],
        },
      }),
    },
    idempotencyKey: overrides.idempotencyKey
      ?? 'plan-action-idempotency-1',
    deadline: clone(overrides.deadline ?? {
      kind: 'contractDefault',
      data: {},
    }),
  };
  return {
    runId: overrides.runId ?? RUN_ID,
    inputId: overrides.inputId ?? 'input-initial',
    planRevision,
    title: overrides.title ?? 'Write reviewed output',
    objective: overrides.objective ?? 'Write one file inside the workspace.',
    narrative: overrides.narrative
      ?? 'Use the approved PlanAction and report canonical facts.',
    evidence: clone(overrides.evidence ?? {
      kernelFactRefs: [],
      readResources: [],
      blockingUnknowns: [],
      nonBlockingUnknowns: [],
      coverage: 'The requested workspace mutation is fully scoped by the user input.',
    }),
    ...(overrides.predecessorPlanRef
      ? { predecessorPlanRef: clone(overrides.predecessorPlanRef) }
      : {}),
    carriedSettlementRefs: clone(overrides.carriedSettlementRefs ?? []),
    actions: clone(overrides.actions ?? [action]),
    recordedAt: overrides.recordedAt ?? NOW,
  };
}
const PREVIEW_KEY_BY_REQUEST = Object.freeze({
  'run-session-v2-contract|plan-revision-1|plan-action-write-output|planned-operation-write-output|output.txt': 'sessionDefault',
  'run-session-v2-contract|plan-two-actions|plan-action-write-first|planned-operation-write-first|output.txt': 'sessionFirstAction',
  'run-session-v2-contract|plan-two-actions|plan-action-write-second|planned-operation-write-second|second.txt': 'sessionSecondAction',
  'run-1|plan-revision-golden-1|plan-action-golden-1|planned-operation-golden-output|output.txt': 'corpusNormal',
  'run-1|plan-revision-golden-deny-1|plan-action-golden-deny-1|planned-operation-golden-deny-output|output.txt': 'corpusNormalDeny',
});
const previewBinding = (preview) => ({
  runId: preview.runId, controlEpoch: preview.controlEpoch,
  planRevision: preview.planRevision, planActionId: preview.planActionId,
  operationId: preview.operationId, toolId: preview.toolId,
  path: preview.canonicalScope.data.targets[0].relativePath,
  contextRef: preview.contextRef,
});
function exactPreview(preview, binding) {
  assert.deepEqual(previewBinding(preview), binding);
  return clone(preview);
}
export function createPreview(request, item, runId) {
  const path = previewItemPath(item);
  const key = [runId, request.planRevision, item.planActionId,
    item.operationId, path].join('|');
  const previewKey = PREVIEW_KEY_BY_REQUEST[key];
  if (!previewKey) throw new Error(`No Rust golden capability preview for ${key}.`);
  return exactPreview(KERNEL_CAPABILITY_PREVIEWS[previewKey], {
    runId, controlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision, planActionId: item.planActionId,
    operationId: item.operationId, toolId: item.toolId,
    path, contextRef: request.toolContextRef,
  });
}
export function createPreviewBatch(request, runId) {
  return {
    runId,
    acceptedControlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision,
    results: request.items.map((item) => ({
      kind: 'previewed',
      data: { preview: createPreview(request, item, runId) },
    })),
  };
}
export function createPlanDiscoveryPreviewBatch(request, approvedPreview) {
  return {
    runId: approvedPreview.runId,
    acceptedControlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision,
    results: request.items.map((item) => {
      assert.equal(item.origin.kind, 'planDiscovery');
      return {
        kind: 'previewed',
        data: {
          preview: {
            ...clone(approvedPreview),
            previewId: `preview-${item.origin.data.discoveryId}`,
            planRevision: request.planRevision,
            planActionId: item.planActionId,
            operationId: item.operationId,
            toolId: item.toolId,
            origin: clone(item.origin),
          },
        },
      };
    }),
  };
}
export function createOutOfPlanDiscoveryPreviewBatch(
  request,
  approvedPreview,
  path = 'expanded.txt'
) {
  assert.equal(request.items.length, 1);
  const item = request.items[0];
  assert.equal(item.origin.kind, 'planDiscovery');
  assert.equal(previewItemPath(item), path);
  const preview = scopedPreviewForItem(
    request,
    item,
    approvedPreview,
    `preview-${item.origin.data.discoveryId}`,
    path
  );
  return {
    runId: approvedPreview.runId,
    acceptedControlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision,
    results: [{ kind: 'previewed', data: { preview } }],
  };
}
export function createInterventionCandidatePreviewBatch(
  request,
  approvedPreview
) {
  return {
    runId: approvedPreview.runId,
    acceptedControlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision,
    results: request.items.map((item) => {
      assert.equal(item.origin.kind, 'interventionCandidate');
      const path = previewItemPath(item);
      return {
        kind: 'previewed',
        data: {
          preview: scopedPreviewForItem(
            request,
            item,
            approvedPreview,
            [
              'preview-intervention',
              item.origin.data.optionId,
              item.planActionId,
            ].join('-'),
            path
          ),
        },
      };
    }),
  };
}
function scopedPreviewForItem(
  request,
  item,
  approvedPreview,
  previewId,
  path
) {
  const canonicalResourceRef = `workspace:Write:${path}`;
  const scopeDigest = sha256Hash(canonicalJson({
    kind: 'workspace',
    path,
    access: 'write',
  }));
  return {
    ...clone(approvedPreview),
    previewId,
    planRevision: request.planRevision,
    planActionId: item.planActionId,
    operationId: item.operationId,
    toolId: item.toolId,
    origin: clone(item.origin),
    scopeDigest,
    authorizationDigest: sha256Hash(canonicalJson({
      previewId,
      scopeDigest,
      origin: item.origin,
    })),
    canonicalScope: {
      kind: 'workspace',
      data: {
        targets: [{
          ...clone(approvedPreview.canonicalScope.data.targets[0]),
          relativePath: path,
        }],
      },
    },
    approvalView: {
      ...clone(approvedPreview.approvalView),
      scopeDigest,
      canonicalTargets: [canonicalResourceRef],
      resourcePresentation: [{
        canonicalResourceRef,
        kind: 'workspacePath',
        label: path,
        workspaceRelativePath: path,
      }],
      summary: `Mutate using ${item.toolId} within 1 canonical target(s)`,
    },
  };
}
function previewItemPath(item) {
  if (item.rawArguments) {
    const path = item.rawArguments.path;
    assert.equal(typeof path, 'string');
    return path;
  }
  if (item.scopeIntent.kind === 'exactInvocation') {
    const path = item.scopeIntent.data.rawArguments.path;
    assert.equal(typeof path, 'string');
    return path;
  }
  const resources = item.scopeIntent.data.requestedResources;
  assert.equal(resources.length, 1);
  assert.equal(resources[0].kind, 'workspacePath');
  return resources[0].data.path;
}
export function createExpandedPreview(request, decision) {
  const previewKey = { allow: 'corpusExpandedAllow',
    deny: 'corpusExpandedDeny' }[decision];
  if (!previewKey) throw new Error(`Unsupported expanded preview decision ${decision}.`);
  const { intent } = request;
  assert.equal(intent.rawArguments.content, 'expanded');
  return exactPreview(KERNEL_CAPABILITY_PREVIEWS[previewKey], {
    runId: intent.runId, controlEpoch: intent.expectedControlEpoch,
    planRevision: intent.authority.data.planRevision,
    planActionId: intent.authority.data.planActionId,
    operationId: intent.operationId, toolId: intent.toolId,
    path: intent.rawArguments.path, contextRef: intent.toolContextRef,
  });
}
export function corpusFact(corpusKey, options = {}) {
  const allowedOptions = new Set(['factId', 'identities', 'ledgerSequence', 'runSequence', 'recordedAt']);
  for (const optionName of Object.keys(options))
    if (!allowedOptions.has(optionName))
      throw new Error(`Unsupported Kernel corpus option ${optionName}.`);
  const template = KERNEL_FACT_CORPUS[corpusKey];
  if (!template) {
    throw new Error(`Unknown Kernel fact corpus key ${corpusKey}.`);
  }
  let fact = clone(template);
  if (options.factId !== undefined) {
    fact = replaceExactIdentity(
      fact,
      template.factId,
      options.factId,
      `factId for ${corpusKey}`
    );
  }
  for (const [identityName, replacement] of Object.entries(
    options.identities ?? {}
  )) {
    const token = CORPUS_IDENTITY_TOKENS[identityName];
    if (token === undefined) {
      throw new Error(`Unknown Kernel corpus identity ${identityName}.`);
    }
    fact = replaceExactIdentity(
      fact,
      token,
      replacement,
      `${identityName} for ${corpusKey}`
    );
  }
  for (const sequenceName of [
    'ledgerSequence',
    'runSequence',
    'recordedAt',
  ]) {
    if (options[sequenceName] !== undefined) {
      fact[sequenceName] = options[sequenceName];
    }
  }
  return decodeKernelFactProjectionV2(fact);
}
function replaceExactIdentity(value, token, replacement, label) {
  let replacements = 0;
  const visit = (current) => {
    if (current === token) {
      replacements += 1;
      return replacement;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([key, item]) => [key, visit(item)])
      );
    }
    return current;
  };
  const result = visit(value);
  if (replacements === 0) {
    throw new Error(
      `Kernel corpus template does not contain requested ${label}.`
    );
  }
  return result;
}
export function admittedReply(harness, request, overrides = {}) {
  const { intent } = request;
  const suffix = intent.operationId.slice(-16);
  const invocationId = overrides.invocationId ?? `invocation-${suffix}`;
  const attemptId = overrides.attemptId ?? `attempt-${suffix}`;
  const contextRead = intent.authority.kind === 'read';
  const mutationContextRead = contextRead && intent.toolContextRef.contextVersion === 3;
  const expanded = !contextRead
    && intent.rawArguments.path === 'expanded.txt';
  if (!contextRead) {
    assert.deepEqual(intent.rawArguments, expanded
      ? { path: 'expanded.txt', content: 'expanded' }
      : { path: 'output.txt', content: 'contract output' });
  }
  const identities = contextRead ? {
    runId: intent.runId, contextReadOperationId: intent.operationId,
    contextReadInvocationId: invocationId, contextReadAttemptId: attemptId,
  } : expanded ? {
    runId: intent.runId, expandedOperationId: intent.operationId,
    expandedInvocationId: invocationId, expandedAttemptId: attemptId,
    planRevision: intent.authority.data.planRevision,
    planActionId: intent.authority.data.planActionId,
  } : {
    runId: intent.runId, operationId: intent.operationId,
    invocationId, attemptId,
    planRevision: intent.authority.data.planRevision,
    planActionId: intent.authority.data.planActionId,
  };
  const admission = corpusFact(mutationContextRead ? 'invocationMutationContextReadAdmitted'
    : contextRead ? 'invocationContextReadAdmitted'
    : expanded ? 'invocationExpandedToolIntentAdmitted'
      : 'invocationToolIntentAdmitted', {
    ...(overrides.admissionFactId
      ? { factId: overrides.admissionFactId } : {}),
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities,
  });
  harness.appendFacts(admission);
  const lease = admission.lineage.capabilityLease;
  return {
    kind: 'admitted',
    data: {
      runId: intent.runId, operationId: intent.operationId,
      acceptedControlEpoch: intent.expectedControlEpoch,
      ...(intent.authority.kind === 'planAction' && lease
        ? { lease: clone(lease) } : {}),
      invocationId, attemptId: admission.lineage.attemptId,
      effectiveDeadlineMs: admission.details.effectiveDeadlineMs,
      admissionFactId: admission.factId,
      admissionBatchHighWater: harness.kernelState.snapshotHighWater,
    },
  };
}
export function awaitingCapabilityReply(harness, request, preview, overrides = {}) {
  const { intent } = request;
  assert.deepEqual(intent.rawArguments,
    { path: 'expanded.txt', content: 'expanded' });
  const denied = intent.authority.data.planRevision
    === 'plan-revision-golden-deny-1';
  const templateKey = denied ? 'authorizationCapabilityAwaitingDeny'
    : 'authorizationCapabilityAwaiting';
  const suffix = intent.operationId.slice(-16);
  const invocationId = overrides.invocationId ?? `invocation-${suffix}`;
  const awaiting = corpusFact(templateKey, {
    ...(overrides.awaitingFactId
      ? { factId: overrides.awaitingFactId } : {}),
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: intent.runId,
      ...(denied ? {
        deniedPlanRevision: preview.planRevision, deniedPlanActionId: preview.planActionId,
        deniedOperationId: intent.operationId,
        deniedExpandedInvocationId: invocationId,
        deniedPreviewId: preview.previewId,
      } : {
        planRevision: preview.planRevision, planActionId: preview.planActionId,
        expandedOperationId: intent.operationId,
        expandedInvocationId: invocationId, previewId: preview.previewId,
      }),
    },
  });
  assert.equal(
    awaiting.details.canonicalArgumentsDigest,
    sha256Hash(
      `deepcode.kernel.tools.v2/canonical-arguments\0${canonicalJson({
        toolId: intent.toolId,
        arguments: intent.rawArguments,
      })}`
    )
  );
  assert.deepEqual({
    scopeDigest: awaiting.details.scopeDigest,
    toolContractDigest: awaiting.details.toolContractDigest,
    contextRef: awaiting.details.contextRef,
  }, {
    scopeDigest: preview.scopeDigest,
    toolContractDigest: preview.toolContractDigest,
    contextRef: preview.contextRef,
  });
  harness.appendFacts(awaiting);
  return {
    kind: 'awaitingCapability',
    data: {
      runId: intent.runId, operationId: intent.operationId,
      acceptedControlEpoch: intent.expectedControlEpoch,
      invocationId, preview: clone(preview),
      awaitingFactId: awaiting.factId,
      awaitingBatchHighWater: harness.kernelState.snapshotHighWater,
    },
  };
}
export function createFactsPage(facts, overrides = {}) {
  const requestedAfterLedgerSequence =
    overrides.requestedAfterLedgerSequence ?? 0;
  const snapshotHighWater = overrides.snapshotHighWater
    ?? facts.at(-1)?.ledgerSequence
    ?? requestedAfterLedgerSequence;
  const hasMore = overrides.hasMore ?? false;
  const nextAfterLedgerSequence = overrides.nextAfterLedgerSequence
    ?? (hasMore
      ? facts.at(-1)?.ledgerSequence ?? requestedAfterLedgerSequence
      : snapshotHighWater);
  return decodedSemanticReply(
    overrides.requestId ?? 'request-facts-fixture',
    'kernelFactsProjected',
    {
      requestedAfterLedgerSequence,
      snapshotHighWater,
      facts: facts.map(decodeKernelFactProjectionV2),
      hasMore,
      nextAfterLedgerSequence,
      ...(overrides.nextContinuation
        ? { nextContinuation: overrides.nextContinuation } : {}),
    }
  );
}
export function decodedSemanticReply(requestId, replyKind, data) {
  const envelope = decodeKernelCommandResponseEnvelopeV2({
    kind: 'correlated',
    data: {
      serverAbiVersion: KERNEL_ABI_V2_VERSION,
      requestId,
      handling: 'evaluated',
      reply: { kind: replyKind, data: clone(data) },
    },
  });
  if (envelope.kind !== 'correlated'
    || envelope.data.reply.kind !== replyKind) {
    throw new Error(`Kernel fixture ${replyKind} was not correlated.`);
  }
  return envelope.data.reply.data;
}
function assertReplyFactBinding(method, reply, kernelState) {
  let factId;
  let highWater;
  if (method === 'submitToolIntent') {
    const prefix = reply.kind === 'admitted'
      ? 'admission'
      : reply.kind === 'awaitingCapability'
        ? 'awaiting'
        : 'rejection';
    factId = reply.data[`${prefix}FactId`];
    highWater = reply.data[`${prefix}BatchHighWater`];
  } else if (method === 'advanceControlEpoch') {
    factId = reply.epochFactId;
    highWater = reply.commandBatchHighWater;
  } else if (method === 'cancelInvocation'
    && (reply.kind === 'requested' || reply.kind === 'alreadyRequested')) {
    factId = reply.data.factId;
    highWater = reply.data.ledgerSequence;
  } else {
    return;
  }
  const factIds = [factId];
  if (method === 'advanceControlEpoch'
    && reply.cancellation.kind !== 'none')
    factIds.push(reply.cancellation.data.cancellationFactId);
  const facts = factIds.map((id) =>
    kernelState.facts.find((candidate) => candidate.factId === id));
  if (facts.some((fact) => !fact || fact.ledgerSequence > highWater)
    || highWater !== kernelState.snapshotHighWater)
    throw new Error(`${method} fixture does not bind its durable fact/high-water.`);
}
function createStore() {
  return {
    checkpoint: undefined,
    plans: new Map(),
    planDecisions: new Map(),
    inputs: new Map(),
    latestInputId: undefined,
    pendingRequests: new Map(),
    settledRequests: [],
    operationResults: new Map(),
    providerEvidence: new Map(),
    toolContextSnapshots: new Map(),
    projectionOutbox: [],
    projectionEvents: [],
    projectedIds: new Set(),
    checkpointHistory: [],
    trace: [],
    requestSequence: 0,
    providerSequence: 0,
    providerRequestCount: 0,
    clockSequence: 0,
  };
}
export function createSessionHarness(options = {}) {
  const initial = createInitialState(options.initial);
  const store = options.store ?? createStore();
  const kernelState = options.kernelState ?? {
    toolContext: clone(initial.toolContext),
    facts: [],
    snapshotHighWater: 0,
  };
  store.providerEvidence ??= new Map();
  store.toolContextSnapshots ??= new Map();
  store.operationResults ??= new Map();
  store.checkpointHistory ??= [];
  store.providerRequestCount ??= 0;
  store.toolContextSnapshots.set(
    toolContextSnapshotKey(toolContextRef(initial.toolContext)),
    clone(initial.toolContext)
  );
  const scripts = new Map();
  const providerOutputs = [];
  const providerInputs = [];
  const kernelCalls = Object.fromEntries(
    Object.keys(REPLY_KINDS).map((method) => [method, []])
  );
  const trace = (value) => store.trace.push(value);
  const nextFactSequence = () =>
    kernelState.snapshotHighWater + 1;
  const nextRunSequence = () => kernelState.facts.reduce(
    (maximum, fact) => fact.lineage.runId === initial.runId
      ? Math.max(maximum, fact.runSequence)
      : maximum,
    0
  ) + 1;
  const appendFacts = (...values) => {
    for (const value of values.flat()) {
      const fact = decodeKernelFactProjectionV2(value);
      if (
        fact.lineage.runId !== initial.runId
        || fact.ledgerSequence <= kernelState.snapshotHighWater
        || kernelState.facts.some(
          (candidate) => candidate.factId === fact.factId
        )
      ) {
        throw new Error(`Invalid appended Kernel fact ${fact.factId}.`);
      }
      kernelState.facts.push(clone(fact));
      kernelState.snapshotHighWater = fact.ledgerSequence;
    }
  };
  const invoke = async (method, request, fallback) => {
    const { signal: _signal, ...serializable } = request;
    const recorded = clone(serializable);
    kernelCalls[method].push(recorded);
    trace(`kernel.${method}:${recorded.requestId}`);
    const queue = scripts.get(method) ?? [];
    const scripted = queue.length ? queue.shift() : fallback;
    if (scripted instanceof Error) throw scripted;
    const semantic = typeof scripted === 'function'
      ? await scripted(recorded)
      : scripted;
    const reply = decodedSemanticReply(
      recorded.requestId,
      REPLY_KINDS[method],
      semantic
    );
    assertReplyFactBinding(method, reply, kernelState);
    return clone(reply);
  };
  const persistence = {
    loadCheckpoint: async () => {
      const checkpoint = clone(store.checkpoint);
      if (!checkpoint) return undefined;
      prepareSessionKernelFactReplayV3(checkpoint.state, {
        coverageAfterLedgerSequence:
          checkpoint.state.reviewFacts.coverageAfterLedgerSequence,
        snapshotHighWater:
          checkpoint.state.lineage.cursor.snapshotHighWater,
      });
      return checkpoint;
    },
    loadProviderTurnEvidence: async (_runId, providerTurnId) =>
      clone(store.providerEvidence.get(providerTurnId) ?? {}),
    loadToolContextSnapshot: async (_runId, contextRef) => {
      const snapshot = store.toolContextSnapshots.get(
        toolContextSnapshotKey(contextRef)
      );
      if (!snapshot) {
        const error = new Error('UnsupportedHistorySchema');
        error.code = 'UnsupportedHistorySchema';
        throw error;
      }
      return clone(snapshot);
    },
    loadLatestPlan: async (runId) => clone(store.plans.get(runId)),
    loadLatestInput: async () => clone(
      store.latestInputId
        ? store.inputs.get(store.latestInputId)
        : undefined
    ),
    loadInput: async (_runId, inputId) => clone(store.inputs.get(inputId)),
    loadPlanDecision: async (_runId, revision) =>
      clone(store.planDecisions.get(revision)),
    loadPendingPublicRequests: async () =>
      [...store.pendingRequests.values()].map(clone),
    async persistPlan(plan) {
      trace(`persistence.persistPlan:${plan.planRevision}`);
      const existing = store.plans.get(plan.runId);
      if (existing?.planRevision === plan.planRevision
        && canonicalJson(existing) !== canonicalJson(plan)) {
        throw new Error('plan_revision_identity_conflict');
      }
      store.plans.set(plan.runId, clone(plan));
    },
    async persistPlanDecision(decision) {
      trace(`persistence.persistPlanDecision:${decision.planRevision}`);
      const existing = store.planDecisions.get(decision.planRevision);
      if (existing && canonicalJson(existing) !== canonicalJson(decision)) {
        throw new Error('plan_decision_identity_conflict');
      }
      store.planDecisions.set(decision.planRevision, clone(decision));
    },
    async persistInput(input) {
      trace(`persistence.persistInput:${input.inputId}`);
      const existing = store.inputs.get(input.inputId);
      if (existing && canonicalJson(existing) !== canonicalJson(input)) {
        throw new Error('input_identity_conflict');
      }
      store.inputs.set(input.inputId, clone(input));
      store.latestInputId = input.inputId;
    },
    async persistPublicRequest(request) {
      trace(`persistence.persistPublicRequest:${request.intent.kind}:${request.requestId}`);
      const existing = store.pendingRequests.get(request.lane);
      if (existing && (existing.requestId !== request.requestId
        || canonicalJson(existing.intent) !== canonicalJson(request.intent))) {
        throw new Error('public_request_identity_conflict');
      }
      store.pendingRequests.set(request.lane, clone(request));
    },
    async settlePublicRequest(request, outcomeDigest, checkpoint, projections) {
      trace(`persistence.settlePublicRequest:${request.intent.kind}:${request.requestId}`);
      const current = store.pendingRequests.get(request.lane);
      if (current?.requestId === request.requestId)
        store.pendingRequests.delete(request.lane);
      store.settledRequests.push({ request: clone(request), outcomeDigest });
      store.checkpoint = clone(checkpoint);
      store.checkpointHistory.push(clone(checkpoint));
      store.projectionOutbox.push(...clone(projections));
    },
    async persistCheckpoint(checkpoint) {
      trace(`persistence.persistCheckpoint:${checkpoint.checkpointRevision}`);
      store.checkpoint = clone(checkpoint);
      store.checkpointHistory.push(clone(checkpoint));
    },
    async persistOperationResult(operationRequestId, result) {
      const record = {
        recordId: `operation-result:${operationRequestId}`,
        recordDigest: sha256Hash(canonicalJson({ operationRequestId })),
        resultDigest: sha256Hash(canonicalJson(result)),
      };
      store.operationResults.set(operationRequestId, {
        record: clone(record), result: clone(result),
      });
      return record;
    },
    async loadOperationResult(operationRequestId) {
      const stored = store.operationResults.get(operationRequestId);
      return stored
        ? {
            resultDigest: stored.record.resultDigest,
            result: clone(stored.result),
          }
        : undefined;
    },
  };
  const projection = {
    async project(event) {
      trace(`projection.project:${event.kind}:${event.projectionId}`);
      const receipt = {
        projectionId: event.projectionId,
        projectionDigest: sha256Hash(canonicalJson(event)),
        delivered: true,
      };
      if (store.projectedIds.has(event.projectionId)) {
        const existing = store.projectionEvents.find(
          (candidate) =>
            candidate.projectionId === event.projectionId
        );
        if (canonicalJson(existing) !== canonicalJson(event)) {
          throw new Error('projection_identity_conflict');
        }
        return receipt;
      }
      store.projectedIds.add(event.projectionId);
      store.projectionEvents.push(clone(event));
      return receipt;
    },
    async flushPending() {
      trace('projection.flushPending');
      const pending = store.projectionOutbox.splice(0);
      for (const event of pending) await projection.project(event);
    },
  };
  const kernel = {
    run: {
      runId: initial.runId,
      workspaceBindingDigest: initial.workspaceBindingDigest,
    },
    getToolContext: (request) => invoke('getToolContext', request, () => ({
      kind: 'current',
      data: { contextRef: toolContextRef(kernelState.toolContext) },
    })),
    previewCapabilityBatch: (request) => invoke(
      'previewCapabilityBatch', request, () => {
        throw new Error('previewCapabilityBatch needs a fixture.');
      }
    ),
    submitToolIntent: (request) => invoke('submitToolIntent', request, () => {
      throw new Error('submitToolIntent needs a fixture.');
    }),
    queryFacts: (request) => invoke('queryFacts', request, (recorded) => {
      const eligible = kernelState.facts.filter((fact) =>
        fact.ledgerSequence > recorded.afterLedgerSequence
        && fact.ledgerSequence <= kernelState.snapshotHighWater);
      const facts = eligible.slice(0, recorded.limit);
      const hasMore = eligible.length > facts.length;
      const next = hasMore
        ? facts.at(-1)?.ledgerSequence ?? recorded.afterLedgerSequence
        : kernelState.snapshotHighWater;
      return createFactsPage(facts, {
        requestedAfterLedgerSequence: recorded.afterLedgerSequence,
        snapshotHighWater: kernelState.snapshotHighWater,
        nextAfterLedgerSequence: next,
        hasMore,
        ...(hasMore ? { nextContinuation: `continuation-${next}` } : {}),
      });
    }),
    advanceControlEpoch: (request) => invoke(
      'advanceControlEpoch', request, (recorded) => {
        const current = recorded.precondition.kind === 'exact'
          ? recorded.precondition.data.controlEpoch
          : 0;
        const acceptedControlEpoch = current + 1;
        const epochFactId = `fact-epoch-${acceptedControlEpoch}`;
        appendFacts(corpusFact('controlEpochAdvanced', {
          factId: epochFactId,
          ledgerSequence: nextFactSequence(),
          runSequence: nextRunSequence(),
          identities: {
            runId: initial.runId,
            inputId: recorded.inputId,
            opaqueInputRef: recorded.opaqueInputRef,
          },
        }));
        return {
          runId: initial.runId, acceptedControlEpoch, epochFactId,
          supersededCapabilityCount: 0,
          cancellation: { kind: 'none', data: {} },
          commandBatchHighWater: kernelState.snapshotHighWater,
        };
      }
    ),
    cancelInvocation: (request) => invoke('cancelInvocation', request,
      (recorded) => ({
        kind: 'noActiveInvocation',
        data: {
          runId: initial.runId,
          controlEpoch: recorded.expectedControlEpoch,
        },
      })),
  };
  const provider = {
    async requestTurn(input) {
      trace(`provider.requestTurn:${input.providerTurnId}`);
      store.providerRequestCount += 1;
      providerInputs.push(input);
      if (!providerOutputs.length) throw new Error('provider output queue is empty');
      const output = providerOutputs.shift();
      if (output instanceof Error) throw output;
      const value = typeof output === 'function'
        ? await output(input)
        : output;
      if (value?.harnessProviderFailure) {
        const failure = value.harnessProviderFailure;
        store.providerEvidence.set(
          input.providerTurnId,
          createFailedProviderEvidence(input, failure.errorCode, {
            recordedAt: new Date(
              Date.parse(NOW) + store.clockSequence++
            ).toISOString(),
            structuredFailure: failure.structuredFailure,
            providerResult: failure.providerResult,
          })
        );
        throw new SessionKernelProviderTransportError(
          failure.errorCode,
          failure.message,
          undefined,
          clone(failure.structuredFailure),
          clone(failure.providerResult.usage)
        );
      }
      const resolved = clone(value);
      store.providerEvidence.set(
        input.providerTurnId,
        createProviderEvidence(input, resolved, {
          recordedAt: new Date(
            Date.parse(NOW) + store.clockSequence++
          ).toISOString(),
        })
      );
      return resolved;
    },
  };
  const harness = {
    initial,
    store,
    kernelState,
    providerInputs,
    ports: {
      kernel,
      persistence,
      provider,
      projection,
      clock: {
        now() {
          return new Date(
            Date.parse(NOW) + store.clockSequence++
          ).toISOString();
        },
        async waitUntil(_instant, signal) {
          if (signal?.aborted) throw signal.reason;
        },
      },
      ids: {
        nextRequestId() {
          return `request-${++store.requestSequence}`;
        },
        nextProviderTurnId() {
          return `provider-turn-${++store.providerSequence}`;
        },
      },
    },
    loop: undefined,
    enqueueKernel(method, value) {
      const queue = scripts.get(method) ?? [];
      queue.push(value);
      scripts.set(method, queue);
    },
    enqueueProvider: (value) => providerOutputs.push(value),
    appendFacts,
    nextFactSequence,
    nextRunSequence,
    setToolContext(toolContext) {
      kernelState.toolContext = clone(toolContext);
      store.toolContextSnapshots.set(
        toolContextSnapshotKey(toolContextRef(toolContext)),
        clone(toolContext)
      );
    },
    calls: (method) => kernelCalls[method],
    traceSince: (index) => store.trace.slice(index),
    async open() {
      harness.loop = await SessionKernelLoopV2.open(
        initial,
        harness.ports,
        { factsPageLimit: 32, maxFactsPagesPerWake: 8 }
      );
      return harness.loop;
    },
  };
  return harness;
}
export async function openSessionHarness(options = {}) {
  const harness = createSessionHarness(options);
  await harness.open();
  return harness;
}
export async function persistPreviewAndAcceptPlan(
  harness,
  plan = createPlan()
) {
  await harness.loop.recordPlan(plan);
  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => createPreviewBatch(request, harness.initial.runId)
  );
  const preview = await harness.loop.previewPlan(plan.planRevision);
  assert.equal(preview.results.length, plan.actions.length);
  assert.equal(preview.results[0].kind, 'previewed');
  const providerTurnId = 'provider-turn-harness-plan-confirmation';
  const confirmationEvent = {
    projectionId: [
      'run',
      harness.initial.runId,
      'plan',
      plan.planRevision,
      'confirmation-ready',
    ].join(':'),
    runId: harness.initial.runId,
    recordedAt: NOW,
    kind: 'plan.confirmationReady',
    data: {
      planRevision: plan.planRevision,
      providerTurnId,
      plan: clone(plan),
      scopePreviews: preview.results.map((result) => {
        assert.equal(result.kind, 'previewed');
        return clone(result.data.preview);
      }),
      recordedAt: NOW,
    },
  };
  const confirmationReceipt = await harness.ports.projection.project(
    confirmationEvent
  );
  let state = harness.loop.snapshot();
  state = recordSessionPlanConfirmationAuthorityV2(
    state,
    buildSessionPlanConfirmationAuthorityV2(state, {
      providerTurnId,
      providerResponseDigest: sha256Hash(canonicalJson({
        kind: 'harness-plan-confirmation',
        planRevision: plan.planRevision,
      })),
      recordedAt: NOW,
      confirmationProjection: {
        projectionId: confirmationReceipt.projectionId,
        projectionDigest: confirmationReceipt.projectionDigest,
      },
    })
  );
  await harness.ports.persistence.persistCheckpoint(
    checkpointSessionKernelStateV2(state, NOW)
  );
  harness.loop = await SessionKernelLoopV2.open(
    harness.initial,
    harness.ports,
    { factsPageLimit: 32, maxFactsPagesPerWake: 8 }
  );
  await harness.loop.decidePlan({
    planRevision: plan.planRevision,
    decision: 'accept',
  });
  return { plan, preview: preview.results[0].data.preview };
}
export function providerToolIntent(
  toolId,
  argumentsValue,
  callId = `call-${toolId.replace('.', '-')}`
) {
  return providerToolIntents([{
    callId,
    toolName: toolId,
    toolId,
    arguments: argumentsValue,
  }]);
}
export function providerToolIntents(calls) {
  const normalized = calls.map((call) => ({
    callId: call.callId,
    toolName: call.toolName ?? call.toolId,
    toolId: call.toolId,
    arguments: clone(call.arguments),
  }));
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'nativeToolCalls',
    calls: normalized,
  }));
  return (input) => {
    const items = providerOrderedToolItems(normalized);
    return {
      kind: 'toolIntent',
      items,
      completion: createProviderCompletionReceipt(responseDigest, {
        hasToolCalls: true,
        reasoningTransport: input.providerProfile.reasoningTransport,
      }),
      sources: normalized.map((call) => ({
        source: 'providerNative',
        callId: call.callId,
        toolId: call.toolId,
        arguments: clone(call.arguments),
      })),
      receipt: {
        schemaVersion: SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
        providerTurnId: input.providerTurnId,
        responseDigest,
        callCount: normalized.length,
        calls: normalized.map((call, index) => ({
          ordinal: index + 1,
          callId: call.callId,
          toolName: call.toolName,
          toolId: call.toolId,
          argumentsDigest: sha256Hash(canonicalJson(call.arguments)),
        })),
        recordedAt: NOW,
      },
      providerResult: {
        providerProfileId: 'provider-profile-v2-contract',
        provider: 'contract-provider',
        model: 'contract-model',
      },
    };
  };
}
export function providerAnswer(text = 'Session answer') {
  const items = [{ kind: 'text', phase: 'unknown', text }];
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'text',
    items,
  }));
  return {
    kind: 'answer',
    items,
    completion: createProviderCompletionReceipt(responseDigest),
    text,
    providerResult: {
      providerProfileId: 'provider-profile-v2-contract',
      provider: 'contract-provider',
      model: 'contract-model',
    },
  };
}

export function providerStructuredFailure(overrides = {}) {
  const errorCode = 'provider_tool_call_arguments_invalid';
  const toolName = overrides.toolName
    ?? SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME;
  const originalArguments = overrides.originalArguments
    ?? '{"plan":{]}invalid';
  const call = {
    index: 0,
    callId: overrides.callId ?? 'call-structured-failure',
    toolName,
    originalArgumentsDigest: sha256Hash(originalArguments),
  };
  const failureDigest = sha256Hash(canonicalJson({
    errorCode,
    calls: [{
      index: call.index,
      toolName: call.toolName,
      originalArgumentsDigest: call.originalArgumentsDigest,
    }],
  }));
  const structuredFailure = {
    schemaVersion: 'deepcode.provider.structured-output-failure.v1',
    disposition: 'repairableNoMutation',
    errorCode,
    failureDigest,
    nativeCompletion: {
      providerKind: 'openaiCompatible',
      terminalSignal: '[DONE]',
      finishReason: 'tool_calls',
    },
    calls: [call],
  };
  const usage = clone(overrides.usage ?? {
    promptCacheHitTokens: 75,
    promptCacheMissTokens: 25,
    inputTokens: 100,
    outputTokens: 16,
    totalTokens: 116,
  });
  return (input) => ({
    harnessProviderFailure: {
      errorCode,
      message:
        'Provider returned invalid structured output after a complete native response.',
      structuredFailure,
      providerResult: {
        providerProfileId: input.providerProfile.providerProfileId,
        provider: 'contract-provider',
        model: 'contract-model',
        usage,
      },
    },
  });
}

export function providerPlanActionComplete(
  outcome = 'completed',
  callId = `plan-action-complete-${outcome}`
) {
  const controlArguments = {
    schemaVersion: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA,
    outcome,
  };
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'planActionComplete',
    callId,
    controlArguments,
  }));
  return (input) => ({
    kind: 'planActionComplete',
    outcome,
    control: {
      schemaVersion: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA,
      callId,
      toolName: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
      argumentsDigest: sha256Hash(canonicalJson(controlArguments)),
    },
    items: [],
    completion: createProviderCompletionReceipt(responseDigest, {
      hasToolCalls: true,
      reasoningTransport: input.providerProfile.reasoningTransport,
    }),
    providerResult: {
      providerProfileId: 'provider-profile-v2-contract',
      provider: 'contract-provider',
      model: 'contract-model',
    },
  });
}

export function providerIntervention(
  draft,
  callId = 'intervention-proposal-1'
) {
  const controlArguments = {
    schemaVersion: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA,
    intervention: clone(draft),
  };
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'intervention',
    callId,
    controlArguments,
  }));
  return (input) => {
    const output = adaptSessionKernelProviderBackendOutputV2(input, {
      kind: 'intervention',
      draft: clone(draft),
      control: {
        schemaVersion: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA,
        callId,
        toolName: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
        argumentsDigest: sha256Hash(canonicalJson(controlArguments)),
      },
      items: [],
      completion: createProviderCompletionReceipt(responseDigest, {
        hasToolCalls: true,
        reasoningTransport: input.providerProfile.reasoningTransport,
      }),
      providerResult: {
        providerProfileId: 'provider-profile-v2-contract',
        provider: 'contract-provider',
        model: 'contract-model',
      },
      responseDigest,
    }, NOW);
    return {
      ...output,
      testInterventionDraft: clone(draft),
    };
  };
}

export function providerOrderedToolItems(calls) {
  return calls.map((call, index) => ({
    kind: 'toolCall',
    source: 'providerNative',
    ordinal: index + 1,
    callId: call.callId,
    toolName: call.toolName ?? call.toolId,
    toolId: call.toolId,
    arguments: clone(call.arguments),
  }));
}

export function createProviderCompletionReceipt(
  responseDigest,
  overrides = {}
) {
  const reasoningTransport = overrides.reasoningTransport
    ?? 'openaiPlaintext';
  const providerKind = {
    openaiPlaintext: 'openaiCompatible',
    anthropicPlaintext: 'anthropic',
    ollamaPlaintext: 'ollama',
  }[reasoningTransport];
  if (!providerKind) {
    throw new Error(
      `Unsupported Provider reasoning transport ${reasoningTransport}.`
    );
  }
  const nativeCompletion = providerKind === 'openaiCompatible'
    ? {
        providerKind,
        terminalSignal: '[DONE]',
        finishReason: overrides.hasToolCalls ? 'tool_calls' : 'stop',
      }
    : providerKind === 'anthropic'
      ? { providerKind, terminalSignal: 'message_stop' }
      : { providerKind, terminalSignal: 'done:true' };
  const receiptIdentity = canonicalJson({
    responseDigest,
    reasoningTransport,
    nativeCompletion,
  });
  return {
    schemaVersion: SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
    nativeCompletion,
    reasoningPresent: true,
    reasoningTransport,
    reasoningDigest: sha256Hash(`reasoning:${receiptIdentity}`),
    responseDigest,
    trace: {
      sealed: true,
      sealDigest: sha256Hash(`seal:${receiptIdentity}`),
      terminalDigest: sha256Hash(`terminal:${receiptIdentity}`),
      recordCount: overrides.recordCount ?? 4,
    },
  };
}

function toolContextSnapshotKey(contextRef) {
  return canonicalJson(contextRef);
}

function createProviderEvidence(input, output, options = {}) {
  if (!output?.completion || !Array.isArray(output.items)) return {};
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
  const recordedAt = options.recordedAt ?? NOW;
  const orderedItems = output.items.map((item, index) =>
    item.kind === 'text'
      ? {
          kind: 'text',
          phase: item.phase,
          text: item.text,
        }
      : {
          kind: 'toolCall',
          index,
          callId: item.callId,
          name: providerWireToolNameV2(item.toolId),
          arguments: canonicalJson(item.arguments),
        }
  );
  if (output.kind === 'planActionComplete') {
    orderedItems.push({
      kind: 'toolCall',
      index: orderedItems.length,
      callId: output.control.callId,
      name: output.control.toolName,
      arguments: canonicalJson({
        schemaVersion: output.control.schemaVersion,
        outcome: output.outcome,
      }),
    });
  }
  if (output.kind === 'intervention') {
    orderedItems.push({
      kind: 'toolCall',
      index: orderedItems.length,
      callId: output.control.callId,
      name: output.control.toolName,
      arguments: canonicalJson({
        schemaVersion: output.control.schemaVersion,
        intervention: output.testInterventionDraft,
      }),
    });
  }
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
    orderedItems,
  };
  const terminalRef = {
    recordId:
      `session-kernel-v3:${input.runId}:provider-turn:${input.providerTurnId}:terminal`,
    recordDigest: sha256Hash(canonicalJson(terminalData)),
  };
  return {
    dispatch: {
      ref: dispatchRef,
      recordedAt: options.dispatchRecordedAt ?? NOW,
      data: dispatchData,
    },
    terminal: {
      ref: terminalRef,
      recordedAt,
      data: terminalData,
    },
  };
}

export function createFailedProviderEvidence(
  input,
  reasonCode = 'provider_retryable_no_mutation',
  options = {}
) {
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
  const traceRef = {
    terminalDigest: sha256Hash(
      `failed-terminal:${input.providerTurnId}:${reasonCode}`
    ),
    sealDigest: sha256Hash(
      `failed-seal:${input.providerTurnId}:${reasonCode}`
    ),
    recordCount: 2,
  };
  const terminalData = {
    schemaVersion: SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA,
    providerTurnId: input.providerTurnId,
    dispatchRef,
    authorityBinding,
    terminalKind: options.terminalKind ?? 'failed',
    reasonCode,
    traceRef,
    orderedItems: [],
    ...(options.structuredFailure
      ? { structuredFailure: clone(options.structuredFailure) }
      : {}),
    ...(options.providerResult
      ? { providerResult: clone(options.providerResult) }
      : {}),
  };
  const terminalRef = {
    recordId:
      `session-kernel-v3:${input.runId}:provider-turn:${input.providerTurnId}:terminal`,
    recordDigest: sha256Hash(canonicalJson(terminalData)),
  };
  return {
    dispatch: {
      ref: dispatchRef,
      recordedAt: options.dispatchRecordedAt ?? NOW,
      data: dispatchData,
    },
    terminal: {
      ref: terminalRef,
      recordedAt: options.recordedAt ?? NOW,
      data: terminalData,
    },
  };
}

function providerAuthorityBinding(input) {
  const currentInput = input.contextAssembly?.receipt?.trimming?.sections
    ?.filter((section) => section.section === 'currentInput') ?? [];
  assert.equal(
    currentInput.length,
    1,
    'Provider fixture must bind one exact current-input section.'
  );
  return {
    runId: input.runId,
    inputId: input.currentInput.inputId,
    controlEpoch: input.controlEpoch,
    currentInputDigest: currentInput[0].digest,
    ...(input.plan
      ? { planRevision: input.plan.planRevision }
      : {}),
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

export function createDurableRecordV3({
  sessionId,
  runId,
  recordKind,
  logicalId,
  recordedAt = NOW,
  data,
}) {
  const withoutDigest = {
    schemaVersion: SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA,
    recordId: `session-kernel-v3:${runId}:${logicalId}`,
    sessionId,
    runId,
    recordKind,
    recordedAt,
    data: clone(data),
  };
  return {
    ...withoutDigest,
    recordDigest: sha256Hash(canonicalJson(withoutDigest)),
  };
}

export function createStoreHeaderRecordV3(
  sessionId,
  runId,
  recordedAt = NOW
) {
  return createDurableRecordV3({
    sessionId,
    runId,
    recordKind: 'storeHeader',
    logicalId: 'store',
    recordedAt,
    data: { schemaVersion: SESSION_KERNEL_PERSISTENCE_V3_SCHEMA },
  });
}

export function createToolContextSnapshotRecordV3(
  sessionId,
  runId,
  toolContext,
  recordedAt = NOW
) {
  const contextRef = toolContextRef(toolContext);
  return createDurableRecordV3({
    sessionId,
    runId,
    recordKind: 'toolContextSnapshot',
    logicalId: `tool-context:${contextRef.contextDigest}`,
    recordedAt,
    data: {
      schemaVersion: SESSION_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA,
      runId,
      contextRef,
      toolContext,
    },
  });
}

export function createTestDurableRecordStoreV3(initialRecords = []) {
  const records = initialRecords.map(clone);
  const appended = [];
  return {
    records,
    appended,
    async list() {
      return records.map(clone);
    },
    async append(record) {
      assert.equal(
        ['toolContextSnapshot', 'providerTurnDispatch',
          'providerTurnTerminal'].includes(record.recordKind),
        false,
        'Session generic append must never create Daemon-owned records.'
      );
      const existing = records.find(
        (candidate) => candidate.recordId === record.recordId
      );
      if (existing) {
        assert.equal(existing.recordDigest, record.recordDigest);
        return;
      }
      records.push(clone(record));
      appended.push(clone(record));
    },
    seedDaemonRecord(record) {
      assert.equal(
        ['toolContextSnapshot', 'providerTurnDispatch',
          'providerTurnTerminal'].includes(record.recordKind),
        true,
        'Only Daemon-owned durable evidence may use the seed lane.'
      );
      const existing = records.find(
        (candidate) => candidate.recordId === record.recordId
      );
      if (existing && existing.recordDigest !== record.recordDigest) {
        throw new Error('daemon_record_identity_conflict');
      }
      if (!existing) records.push(clone(record));
    },
  };
}

export function createDurablePersistenceHarness(options = {}) {
  const sessionId = options.sessionId ?? 'session-v3-durable-contract';
  const initial = createInitialState(options.initial);
  const records = options.records ?? [
    createStoreHeaderRecordV3(sessionId, initial.runId),
    createToolContextSnapshotRecordV3(
      sessionId,
      initial.runId,
      initial.toolContext
    ),
  ];
  const store = createTestDurableRecordStoreV3(records);
  const persistence = new SessionKernelAppendOnlyPersistenceV3(
    sessionId,
    initial.runId,
    options.historySchema ?? SESSION_KERNEL_PERSISTENCE_V3_SCHEMA,
    store
  );
  return { sessionId, initial, store, persistence };
}

export function checkpointFromStateV3(state, savedAt = NOW) {
  return {
    schemaVersion: SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
    checkpointRevision: state.checkpointRevision,
    savedAt,
    state: clone(state),
  };
}

export function providerEvidenceRecordsV3(
  sessionId,
  runId,
  input,
  output,
  recordedAt = NOW
) {
  const evidence = createProviderEvidence(input, output, { recordedAt });
  if (!evidence.dispatch || !evidence.terminal) {
    throw new Error('completed_provider_evidence_required');
  }
  const dispatch = createDurableRecordV3({
    sessionId,
    runId,
    recordKind: 'providerTurnDispatch',
    logicalId: `provider-turn:${input.providerTurnId}:dispatch`,
    recordedAt: evidence.dispatch.recordedAt,
    data: evidence.dispatch.data,
  });
  const terminalData = {
    ...clone(evidence.terminal.data),
    dispatchRef: {
      recordId: dispatch.recordId,
      recordDigest: dispatch.recordDigest,
    },
  };
  const terminal = createDurableRecordV3({
    sessionId,
    runId,
    recordKind: 'providerTurnTerminal',
    logicalId: `provider-turn:${input.providerTurnId}:terminal`,
    recordedAt: evidence.terminal.recordedAt,
    data: terminalData,
  });
  return { dispatch, terminal };
}
