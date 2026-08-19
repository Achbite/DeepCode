import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  KERNEL_ABI_V2_VERSION,
  KERNEL_TOOL_CONTEXT_V2_FORMAT,
  KernelV2WireError,
  decodeKernelCommandEnvelopeV2,
  decodeKernelCommandResponseEnvelopeV2,
  decodeKernelFactProjectionV2,
  decodeRawToolArgumentsV2,
  decodeToolContextBundleV2,
  decodeToolIntentV2,
} from '@deepcode/protocol';

const SUITE_ID = 'session.v2.contracts';
if (
  process.env.DEEPCODE_TEST_CONTROLLER !== '1'
  || process.env.DEEPCODE_TEST_SUITE_ID !== SUITE_ID
) {
  throw new Error(
    'Kernel v2 wire contracts are internal; use ./test.sh --suite session.v2.contracts.'
  );
}

const fixtureUrl = new URL(
  '../../../fixtures/kernel-session-v2/wire-golden.json',
  import.meta.url
);
const golden = JSON.parse(await readFile(fixtureUrl, 'utf8'));

assert.deepEqual(
  Object.keys(golden).sort(),
  [
    'kernelCapabilityPreviews',
    'kernelFactCorpus',
    'kernelMutationToolContext',
    'kernelToSessionFactProjection',
    'kernelToolContext',
    'schemaVersion',
    'sessionToKernelToolIntent',
  ].sort(),
  'the shared golden must keep its frozen Rust/TypeScript top-level shape'
);
assert.equal(
  golden.schemaVersion,
  'deepcode.kernel-session.wire-golden.v3',
  'the shared golden schema must be explicitly versioned'
);

const command = decodeKernelCommandEnvelopeV2(
  golden.sessionToKernelToolIntent
);
assert.deepEqual(
  command,
  golden.sessionToKernelToolIntent,
  'the public TypeScript decoder must preserve the Rust ToolIntent wire vector'
);
assert.equal(command.abiVersion, KERNEL_ABI_V2_VERSION);
assert.equal(command.command.kind, 'toolIntentSubmit');
assert.deepEqual(
  decodeToolIntentV2(command.command.data),
  command.command.data,
  'the standalone ToolIntent decoder must enforce the same public contract'
);

const fact = decodeKernelFactProjectionV2(
  golden.kernelToSessionFactProjection
);
assert.deepEqual(
  fact.details,
  golden.kernelToSessionFactProjection.details,
  'the public TypeScript decoder must preserve the Kernel-generated fact payload'
);
assert.equal(fact.abiVersion, KERNEL_ABI_V2_VERSION);
assert.equal(fact.domain, 'effect');
assert.equal(fact.factKind, 'toolObserved');
assert.equal(
  fact.lineage.runId,
  command.command.data.runId,
  'both directions must preserve the same run identity'
);
assert.equal(fact.lineage.controlEpoch, command.command.data.expectedControlEpoch);
assert.equal(fact.lineage.operationId, command.command.data.operationId);
assert.deepEqual(fact.lineage.planActionIds, ['plan-action-golden-1']);
assert.deepEqual(
  fact.lineage.capabilityLease,
  command.command.data.authority.data.lease
);
assert.equal(fact.lineage.invocationId, 'invocation-golden-readme-1');
assert.equal(fact.lineage.attemptId, 'attempt-golden-readme-1');
assert.equal(fact.lineage.effectId, 'effect-golden-readme-1');
assert.deepEqual(
  fact.lineage.resourceIds,
  ['resource-01-readme', 'resource-02-workspace-index'],
  'ResourceId lineage must remain UTF-8 sorted and unique'
);

const expectedCorpusKeys = [
  'authorizationCapabilityAwaiting',
  'authorizationCapabilityAwaitingDeny',
  'authorizationCapabilityIssued',
  'authorizationCapabilityIssuedDeny',
  'authorizationContextInvalidated',
  'authorizationExpansionAllowed',
  'authorizationExpansionDenied',
  'authorizationLeaseRevoked',
  'authorizationLeaseSuperseded',
  'cleanupCompleted',
  'cleanupScheduled',
  'controlCancellationRequested',
  'controlCommandRecordedRejectedInvalidPathToolIntent',
  'controlCommandRecordedRejectedToolIntent',
  'controlEpochAdvanced',
  'effectContextReadObserved',
  'effectExpandedToolObserved',
  'effectMutationContextReadObserved',
  'effectToolObserved',
  'invocationContextReadAdmitted',
  'invocationContextReadCompleted',
  'invocationExpandedToolCompleted',
  'invocationExpandedToolIntentAdmitted',
  'invocationMutationContextReadAdmitted',
  'invocationMutationContextReadCompleted',
  'invocationToolCompleted',
  'invocationToolIndeterminate',
  'invocationToolIntentAdmitted',
].sort();
assert.deepEqual(
  Object.keys(golden.kernelFactCorpus).sort(),
  expectedCorpusKeys,
  'the shared corpus must contain every and only the Rust-generated fact template'
);
const decodedCorpus = Object.fromEntries(
  expectedCorpusKeys.map((key) => {
    const decoded = decodeKernelFactProjectionV2(
      golden.kernelFactCorpus[key]
    );
    assert.deepEqual(
      decoded.details,
      golden.kernelFactCorpus[key].details,
      `${key} must preserve the Rust-generated typed fact data`
    );
    assert.equal(decoded.factId, golden.kernelFactCorpus[key].factId);
    assert.equal(decoded.domain, golden.kernelFactCorpus[key].domain);
    assert.equal(decoded.factKind, golden.kernelFactCorpus[key].factKind);
    return [key, decoded];
  })
);
const expansionAllowed =
  decodedCorpus.authorizationExpansionAllowed;
const expandedAwaiting =
  decodedCorpus.authorizationCapabilityAwaiting;
const resumedAdmission =
  decodedCorpus.invocationExpandedToolIntentAdmitted;
const revokedLease =
  decodedCorpus.authorizationLeaseRevoked;
const supersededLease =
  decodedCorpus.authorizationLeaseSuperseded;
assert.equal(revokedLease.domain, 'authorization');
assert.equal(revokedLease.factKind, 'leaseRevoked');
assert.equal(revokedLease.lineage.capabilityLease.version, 1);
assert.deepEqual(
  revokedLease.lineage.capabilityLease,
  {
    leaseId: revokedLease.details.identity.leaseId,
    version: revokedLease.details.identity.leaseVersion,
    scopeDigest: revokedLease.details.scopeDigest,
  }
);
assert.equal(supersededLease.domain, 'authorization');
assert.equal(supersededLease.factKind, 'leaseSuperseded');
assert.equal(supersededLease.lineage.capabilityLease.version, 2);
assert.deepEqual(
  supersededLease.lineage.capabilityLease,
  {
    leaseId: supersededLease.details.identity.leaseId,
    version: supersededLease.details.identity.leaseVersion,
    scopeDigest: supersededLease.details.scopeDigest,
  }
);
assert.equal(
  expansionAllowed.lineage.invocationId,
  undefined,
  'an ExpansionAllowed fact must not invent invocation lineage'
);
assert.equal(
  resumedAdmission.lineage.invocationId,
  expandedAwaiting.lineage.invocationId,
  'the resumed admission must continue the exact awaiting invocation'
);
assert.equal(
  expandedAwaiting.lineage.attemptId,
  undefined,
  'AwaitingCapability must not create an attempt before approval'
);
assert.equal(
  typeof resumedAdmission.lineage.attemptId,
  'string',
  'the resumed admission must create an attempt after approval'
);
assert.deepEqual(
  resumedAdmission.lineage.capabilityLease,
  expansionAllowed.lineage.capabilityLease,
  'the resumed admission must use the versioned expansion lease'
);
assert.equal(
  resumedAdmission.lineage.capabilityLease.version,
  2,
  'scope expansion must advance the lease version'
);
const normalAdmission =
  decodedCorpus.invocationToolIntentAdmitted;
const normalEffect = decodedCorpus.effectToolObserved;
const normalCompleted = decodedCorpus.invocationToolCompleted;
assert.equal(
  normalAdmission.details.resourceScope.data.targets[0].relativePath,
  'output.txt'
);
assert.equal(normalCompleted.details.output.path, 'output.txt');
assert.match(
  normalAdmission.details.canonicalArgumentsDigest,
  /^sha256:[0-9a-f]{64}$/,
  'admitted invocation facts must retain their canonical arguments digest'
);
assert.equal(
  normalAdmission.details.toolContractDigest,
  golden.kernelCapabilityPreviews.corpusNormal.toolContractDigest
);
assert.equal(
  normalAdmission.details.workspaceBindingDigest,
  `sha256:${'d'.repeat(64)}`
);
assert.equal(
  normalEffect.lineage.operationId,
  normalAdmission.lineage.operationId
);
assert.equal(
  normalCompleted.lineage.effectId,
  normalEffect.lineage.effectId
);

const expandedEffect =
  decodedCorpus.effectExpandedToolObserved;
const expandedCompleted =
  decodedCorpus.invocationExpandedToolCompleted;
const expandedPreview =
  golden.kernelCapabilityPreviews.corpusExpandedAllow;
assert.equal(
  expandedAwaiting.details.canonicalArgumentsDigest,
  resumedAdmission.details.canonicalArgumentsDigest,
  'awaiting and resumed invocation facts must retain the same canonical arguments digest'
);
assert.equal(
  expandedAwaiting.details.scopeDigest,
  expandedPreview.scopeDigest
);
assert.equal(
  expandedAwaiting.details.toolContractDigest,
  expandedPreview.toolContractDigest
);
assert.deepEqual(
  expandedAwaiting.details.contextRef,
  expandedPreview.contextRef
);
assert.equal(
  resumedAdmission.details.resourceScope.data.targets[0].relativePath,
  'expanded.txt'
);
assert.equal(expandedCompleted.details.output.path, 'expanded.txt');
assert.equal(
  expandedEffect.lineage.operationId,
  resumedAdmission.lineage.operationId
);
assert.equal(
  expandedCompleted.lineage.effectId,
  expandedEffect.lineage.effectId
);

const denyAwaiting =
  decodedCorpus.authorizationCapabilityAwaitingDeny;
const denied = decodedCorpus.authorizationExpansionDenied;
const denyPreview =
  golden.kernelCapabilityPreviews.corpusExpandedDeny;
assert.deepEqual(
  Object.keys(golden.kernelCapabilityPreviews).sort(),
  [
    'corpusExpandedAllow',
    'corpusExpandedDeny',
    'corpusNormal',
    'corpusNormalDeny',
    'sessionDefault',
    'sessionFirstAction',
    'sessionInterventionCandidateSelected',
    'sessionInterventionCandidateSuperseded',
    'sessionPlanDiscovery',
    'sessionSecondAction',
  ].sort(),
  'the shared preview vectors must be a sorted-key-independent Rust set'
);
for (const preview of Object.values(golden.kernelCapabilityPreviews)) {
  assert.deepEqual(
    preview.authorizationBinding,
    { kind: 'resourceScope', data: {} },
    'resource-scope preview vectors must carry the immutable authorization binding'
  );
  assert.equal(
    Object.hasOwn(preview, 'canonicalArgumentsDigest'),
    false,
    'resource-scope preview authority must not retain invocation arguments'
  );
  assert.deepEqual(
    preview.approvalView.resourcePresentation.map(
      (resource) => resource.canonicalResourceRef
    ),
    preview.approvalView.canonicalTargets,
    'safe resource presentation must preserve canonical target identity'
  );
}
const planDiscoveryPreview =
  golden.kernelCapabilityPreviews.sessionPlanDiscovery;
const selectedCandidatePreview =
  golden.kernelCapabilityPreviews.sessionInterventionCandidateSelected;
const supersededCandidatePreview =
  golden.kernelCapabilityPreviews.sessionInterventionCandidateSuperseded;
assert.deepEqual(planDiscoveryPreview.origin, {
  kind: 'planDiscovery',
  data: { discoveryId: 'discovery-wire-golden-1' },
});
assert.equal(selectedCandidatePreview.origin.kind, 'interventionCandidate');
assert.equal(
  selectedCandidatePreview.origin.data.candidateSetDigest,
  supersededCandidatePreview.origin.data.candidateSetDigest
);
assert.equal(
  selectedCandidatePreview.origin.data.interactionId,
  supersededCandidatePreview.origin.data.interactionId
);
assert.notEqual(
  selectedCandidatePreview.origin.data.optionId,
  supersededCandidatePreview.origin.data.optionId,
  'one intervention candidate set must retain distinct option identities'
);
assert.equal(
  selectedCandidatePreview.disposition,
  'requiresUserDecision',
  'candidate-only previews must never become auto-issuable authority'
);
assert.equal(denyAwaiting.details.scopeDigest, denyPreview.scopeDigest);
assert.equal(
  denyAwaiting.details.canonicalArgumentsDigest,
  expandedAwaiting.details.canonicalArgumentsDigest,
  'equivalent denied and allowed invocation facts must retain the same arguments digest'
);
assert.equal(
  denied.details.requestedScopeDigest,
  denyPreview.scopeDigest
);
assert.equal(
  denied.details.authorizationDigest,
  denyPreview.authorizationDigest
);
assert.notEqual(
  denyPreview.previewId,
  expandedPreview.previewId,
  'allow and deny previews must retain independent identities'
);
const contextReadAdmission =
  decodedCorpus.invocationContextReadAdmitted;
assert.equal(
  contextReadAdmission.details.toolId,
  'fs.read',
  'bounded context-read smoke facts must describe the same ready tool'
);
assert.equal(contextReadAdmission.lineage.capabilityLease, undefined);
assert.deepEqual(contextReadAdmission.lineage.planActionIds, []);
assertNoForbiddenSecretFields(golden.kernelFactCorpus);

const publicToolContext = decodeToolContextBundleV2(
  golden.kernelToolContext
);
const mutationToolContext = decodeToolContextBundleV2(
  golden.kernelMutationToolContext
);
assert.deepEqual(
  mutationToolContext,
  golden.kernelMutationToolContext,
  'TypeScript must consume the exact two-tool mutation context materialized by Rust'
);
assert.equal(mutationToolContext.contextVersion, 3);
assert.deepEqual(
  mutationToolContext.tools.map((tool) => ({
    toolId: tool.toolId,
    authorizationShape: tool.authorizationShape,
  })),
  [
    { toolId: 'fs.read', authorizationShape: 'resourceScope' },
    { toolId: 'fs.write', authorizationShape: 'resourceScope' },
  ]
);
assert.deepEqual(
  decodedCorpus.authorizationContextInvalidated
    .details.previousContext,
  {
    contextVersion: mutationToolContext.contextVersion,
    catalogDigest: mutationToolContext.catalogDigest,
    contextDigest: mutationToolContext.contextDigest,
  },
  'ContextInvalidated must bind the real prior mutation context'
);
assert.deepEqual(
  decodedCorpus.invocationMutationContextReadAdmitted
    .details.identity.authority.data.toolContextRef,
  {
    contextVersion: mutationToolContext.contextVersion,
    catalogDigest: mutationToolContext.catalogDigest,
    contextDigest: mutationToolContext.contextDigest,
  },
  'required Session context reads must bind the v3 mutation context'
);
assert.deepEqual(
  publicToolContext,
  golden.kernelToolContext,
  'TypeScript must consume the exact single-tool ToolContext materialized by Rust'
);
assert.equal(publicToolContext.formatVersion, KERNEL_TOOL_CONTEXT_V2_FORMAT);
assert.equal(publicToolContext.tools.length, 1);
assert.equal(publicToolContext.tools[0].toolId, command.command.data.toolId);
assert.deepEqual(
  decodedCorpus.authorizationContextInvalidated.details.nextContextRef,
  {
    contextVersion: publicToolContext.contextVersion,
    catalogDigest: publicToolContext.catalogDigest,
    contextDigest: publicToolContext.contextDigest,
  },
  'ContextInvalidated must bind the real next read-only context'
);
assert.deepEqual(
  {
    contextVersion: publicToolContext.contextVersion,
    catalogDigest: publicToolContext.catalogDigest,
    contextDigest: publicToolContext.contextDigest,
  },
  command.command.data.toolContextRef,
  'ToolIntent must bind the exact ToolContext version and digests'
);
for (const field of [
  'runCapability',
  'decisionCapability',
  'hostShellCapability',
]) {
  for (const context of [
    golden.kernelToolContext,
    golden.kernelMutationToolContext,
  ]) {
    const leaked = clone(context);
    leaked[field] = `${field}-secret-must-not-cross`;
    assertWireRejected(
      () => decodeToolContextBundleV2(leaked),
      `${field} must not enter a public ToolContext bundle`
    );
  }
}

const v1Command = clone(golden.sessionToKernelToolIntent);
v1Command.abiVersion = 'deepcode.kernel.abi.v1';
assertWireRejected(
  () => decodeKernelCommandEnvelopeV2(v1Command),
  'a v1 command must not enter the v2 Session/Kernel path'
);

const unknownCommandField = clone(golden.sessionToKernelToolIntent);
unknownCommandField.command.data.legacySessionId = 'legacy-session';
assertWireRejected(
  () => decodeKernelCommandEnvelopeV2(unknownCommandField),
  'unknown ToolIntent fields must fail closed'
);

for (const [field, value] of [
  ['risk', 'low'],
  ['effectScope', 'workspaceRead'],
  ['resourceScope', { kind: 'workspace', data: { paths: ['README.md'] } }],
  ['grantId', 'caller-asserted-grant'],
]) {
  const forged = clone(golden.sessionToKernelToolIntent);
  forged.command.data[field] = value;
  assertWireRejected(
    () => decodeKernelCommandEnvelopeV2(forged),
    `the caller must not assert Kernel-owned ${field}`
  );
}

const unknownFactField = clone(golden.kernelToSessionFactProjection);
unknownFactField.lineage.sessionId = 'legacy-session';
assertWireRejected(
  () => decodeKernelFactProjectionV2(unknownFactField),
  'unknown fact lineage fields must fail closed'
);

const v1Fact = clone(golden.kernelToSessionFactProjection);
v1Fact.abiVersion = 'deepcode.kernel.abi.v1';
assertWireRejected(
  () => decodeKernelFactProjectionV2(v1Fact),
  'a v1 fact projection must not enter the v2 Session path'
);

const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const aboveMaximumSafeInteger = maximumSafeInteger + 1;

const maximumEpochCommand = clone(golden.sessionToKernelToolIntent);
maximumEpochCommand.command.data.expectedControlEpoch = maximumSafeInteger;
decodeKernelCommandEnvelopeV2(maximumEpochCommand);
const unsafeEpochCommand = clone(maximumEpochCommand);
unsafeEpochCommand.command.data.expectedControlEpoch = aboveMaximumSafeInteger;
assertWireRejected(
  () => decodeKernelCommandEnvelopeV2(unsafeEpochCommand),
  'a ToolIntent control epoch above the cross-language safe boundary must fail closed'
);

const maximumCursorCommand = {
  abiVersion: KERNEL_ABI_V2_VERSION,
  requestId: 'request-facts-at-safe-boundary',
  command: {
    kind: 'kernelFactsQueryScoped',
    data: {
      runId: command.command.data.runId,
      afterLedgerSequence: maximumSafeInteger,
      limit: 1,
    },
  },
};
decodeKernelCommandEnvelopeV2(maximumCursorCommand);
const unsafeCursorCommand = clone(maximumCursorCommand);
unsafeCursorCommand.command.data.afterLedgerSequence = aboveMaximumSafeInteger;
assertWireRejected(
  () => decodeKernelCommandEnvelopeV2(unsafeCursorCommand),
  'a facts cursor above the cross-language safe boundary must fail closed'
);

const maximumSequenceFact = clone(golden.kernelToSessionFactProjection);
maximumSequenceFact.ledgerSequence = maximumSafeInteger;
maximumSequenceFact.runSequence = maximumSafeInteger;
maximumSequenceFact.details.safeIntegerBoundary = maximumSafeInteger;
decodeKernelFactProjectionV2(maximumSequenceFact);
for (const field of ['ledgerSequence', 'runSequence']) {
  const unsafeFact = clone(maximumSequenceFact);
  unsafeFact[field] = aboveMaximumSafeInteger;
  assertWireRejected(
    () => decodeKernelFactProjectionV2(unsafeFact),
    `a fact ${field} above the cross-language safe boundary must fail closed`
  );
}
const unsafeFactDetails = clone(maximumSequenceFact);
unsafeFactDetails.details.safeIntegerBoundary = aboveMaximumSafeInteger;
assertWireRejected(
  () => decodeKernelFactProjectionV2(unsafeFactDetails),
  'a nested fact detail above the cross-language safe boundary must fail closed'
);

const maximumHighWaterReply = {
  kind: 'correlated',
  data: {
    serverAbiVersion: KERNEL_ABI_V2_VERSION,
    requestId: 'request-facts-reply-at-safe-boundary',
    handling: 'evaluated',
    reply: {
      kind: 'kernelFactsProjected',
      data: {
        requestedAfterLedgerSequence: maximumSafeInteger,
        snapshotHighWater: maximumSafeInteger,
        facts: [],
        hasMore: false,
        nextAfterLedgerSequence: maximumSafeInteger,
      },
    },
  },
};
decodeKernelCommandResponseEnvelopeV2(maximumHighWaterReply);
const unsafeHighWaterReply = clone(maximumHighWaterReply);
unsafeHighWaterReply.data.reply.data.snapshotHighWater =
  aboveMaximumSafeInteger;
assertWireRejected(
  () => decodeKernelCommandResponseEnvelopeV2(unsafeHighWaterReply),
  'a reply high-water above the cross-language safe boundary must fail closed'
);

const zeroRejectionHighWaterReply = {
  kind: 'correlated',
  data: {
    serverAbiVersion: KERNEL_ABI_V2_VERSION,
    requestId: 'request-zero-rejection-high-water',
    handling: 'evaluated',
    reply: {
      kind: 'toolIntentSubmission',
      data: clone(
        decodedCorpus
          .controlCommandRecordedRejectedInvalidPathToolIntent
          .details.result.data.reply
      ),
    },
  },
};
zeroRejectionHighWaterReply
  .data.reply.data.data.rejectionBatchHighWater = 0;
assertWireRejected(
  () => decodeKernelCommandResponseEnvelopeV2(
    zeroRejectionHighWaterReply
  ),
  'a ToolIntent rejection must bind a positive durable fact high-water'
);

const awaitingPreview =
  golden.kernelCapabilityPreviews.corpusExpandedAllow;
const awaitingCapabilityReply = {
  kind: 'correlated',
  data: {
    serverAbiVersion: KERNEL_ABI_V2_VERSION,
    requestId: 'request-awaiting-capability-reply',
    handling: 'evaluated',
    reply: {
      kind: 'toolIntentSubmission',
      data: {
        kind: 'awaitingCapability',
        data: {
          runId: awaitingPreview.runId,
          operationId: awaitingPreview.operationId,
          acceptedControlEpoch: awaitingPreview.controlEpoch,
          invocationId: 'invocation-awaiting-capability',
          preview: clone(awaitingPreview),
          awaitingFactId: 'fact-awaiting-capability',
          awaitingBatchHighWater: 1,
        },
      },
    },
  },
};
decodeKernelCommandResponseEnvelopeV2(awaitingCapabilityReply);
for (const [field, value] of [
  ['runId', 'run-awaiting-mismatch'],
  ['operationId', 'operation-awaiting-mismatch'],
  ['acceptedControlEpoch', awaitingPreview.controlEpoch + 1],
]) {
  const mismatched = clone(awaitingCapabilityReply);
  mismatched.data.reply.data.data[field] = value;
  assertWireRejected(
    () => decodeKernelCommandResponseEnvelopeV2(mismatched),
    `an AwaitingCapability reply must bind preview.${field} to its top-level identity`
  );
}

assertWireRejected(
  () => decodeRawToolArgumentsV2({ ['界'.repeat(342)]: true }),
  'rawArguments must reject an object key above the 1024-byte UTF-8 limit'
);
assertWireRejected(
  () => decodeRawToolArgumentsV2({ ['bad\u0085key']: true }),
  'rawArguments must reject C1 control characters in object keys'
);

const oversizedFactPage = {
  kind: 'correlated',
  data: {
    serverAbiVersion: KERNEL_ABI_V2_VERSION,
    requestId: 'request-fact-page-too-large',
    handling: 'evaluated',
    reply: {
      kind: 'kernelFactsProjected',
      data: {
        requestedAfterLedgerSequence: 0,
        snapshotHighWater: 1001,
        facts: Array.from(
          { length: 1001 },
          () => clone(golden.kernelToSessionFactProjection)
        ),
        hasMore: false,
        nextAfterLedgerSequence: 1001,
        nextContinuation: null,
      },
    },
  },
};
assertWireRejected(
  () => decodeKernelCommandResponseEnvelopeV2(oversizedFactPage),
  'a Kernel fact projection page must reject more than 1000 facts'
);

function assertWireRejected(decode, message) {
  assert.throws(
    decode,
    (error) =>
      error instanceof KernelV2WireError
      && error.code === 'kernel_v2_wire_invalid',
    message
  );
}

function clone(value) {
  return structuredClone(value);
}

function assertNoForbiddenSecretFields(value) {
  const forbidden = new Set([
    'runCapability',
    'decisionCapability',
    'hostShellCapability',
    'capabilityToken',
    'token',
  ]);
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      assert.equal(
        forbidden.has(key),
        false,
        `${key} must not enter the public Kernel fact corpus`
      );
      pending.push(child);
    }
  }
}
