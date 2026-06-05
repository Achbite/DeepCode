import {
  AgentPlanParseError,
  LocalL2Cache,
  attachKernelPlanReview,
  buildConversationProjection,
  buildDynamicWorkflowSession,
  buildPromptEnvelope,
  buildReviewPacket,
  canonicalizePrompt,
  canonicalizeToolSchema,
  compileActionBundleToPlanContract,
  createProjectIndex,
  createResourcePacket,
  createApprovedTaskQueue,
  createDraftTaskQueue,
  decidePermissionAutoApproval,
  decidePlanConfirmation,
  deriveContextLayering,
  createPlanContractSubmitCommand,
  exportConversationProjection,
  parseAgentPlanOutput,
  parseAgentPlan,
  providerTelemetryFromUsage,
  selectDynamicWorkflow,
  SingleflightDeduper,
  applyProviderCacheStrategy,
  type AgentPlanParts,
  type PromptEnvelopeParts,
  type ResourceManifest,
  type ResourceRequest,
} from '../index.js';

const VALID_PLAN = `<USER_PLAN>
Plan: update one file after review.
</USER_PLAN>

<ACTION_BUNDLE format="json" version="1">
{
  "version": "1",
  "id": "plan-1",
  "goal": "Update a small workspace file.",
  "requirementId": "req-1",
  "actions": [
    {
      "id": "read-readme",
      "title": "Read README",
      "kind": "read",
      "capability": "workspace.read",
      "resourceScope": ["README.md"],
      "canParallelize": true,
      "conflictKeys": []
    },
    {
      "id": "write-file",
      "title": "Write file",
      "kind": "write",
      "capability": "workspace.write",
      "resourceScope": ["src/example.ts"],
      "canParallelize": false,
      "conflictKeys": ["src/example.ts"],
      "sourceBlockId": "CODE_BLOCK_example"
    }
  ],
  "validationExpectations": [
    {
      "id": "validation-1",
      "description": "TypeScript typecheck should pass.",
      "command": "pnpm --filter @deepcode/session-core typecheck"
    }
  ],
  "reviewExpectations": [
    {
      "id": "review-1",
      "description": "User reviews whether the change matches the request."
    }
  ],
  "repairPolicy": {
    "maxRounds": 2,
    "allowedFiles": ["src/example.ts"],
    "forbidNewFilesAfterApproval": true,
    "forbidNewPermissionsAfterApproval": true
  }
}
</ACTION_BUNDLE>

<CODE_BLOCK id="CODE_BLOCK_example" path="src/example.ts">
export const value = 1;
</CODE_BLOCK>

<EXPECTED_VALIDATION>
The typecheck command is expected to exit with zero after execution.
</EXPECTED_VALIDATION>

<REVIEW_GUIDE>
Review the file diff and whether the new value is acceptable.
</REVIEW_GUIDE>`;

async function main(): Promise<void> {
  const parsed = parseAgentPlan(VALID_PLAN);
  assertEqual(parsed.actionBundle.id, 'plan-1', 'valid plan parses action bundle');
  assertEqual(parsed.codeBlocks.length, 1, 'valid plan parses code block');
  assert(!parsed.permissionHints, 'valid plan does not produce permission hints by default');

  const contract = compileActionBundleToPlanContract(parsed.actionBundle);
  assertEqual(contract.requiredCapabilities.join(','), 'workspace.read,workspace.write', 'contract capabilities are sorted');
  assertEqual(contract.requiresUserApproval, true, 'write capability requires user approval');

  const command = createPlanContractSubmitCommand({
    requestId: 'req-plan-review',
    runId: 'run-1',
    sessionId: 'session-1',
    bundle: parsed.actionBundle,
  });
  assertEqual(command.kind, 'planContractSubmit', 'plan submit command uses existing ABI command');

  const draftQueue = createDraftTaskQueue({ queueId: 'queue-1', actionBundle: parsed.actionBundle });
  assertEqual(draftQueue.status, 'draft', 'draft queue is not executable');

  const preflighted = attachKernelPlanReview(draftQueue, {
    planId: 'plan-1',
    status: 'awaitingTemporaryGrant',
    requiredCapabilities: contract.requiredCapabilities,
    requiredPermissions: ['temporaryGrant:workspace.write'],
    permissionGaps: ['workspace.write'],
    hardFloorHits: [],
    deniedReasons: [],
    blockedReasons: [],
    findings: [],
    kernelGeneratedPermissionSummary: 'Kernel preflight: status=awaitingTemporaryGrant.',
  });
  assertEqual(preflighted.status, 'kernelPreflighted', 'kernel report attaches to draft queue');
  assert(preflighted.kernelPlanReview, 'kernel report is present after preflight');
  assertThrows(() => createApprovedTaskQueue({ queue: preflighted, planId: 'plan-1', userConfirmed: false }), 'user confirmation');
  const approved = createApprovedTaskQueue({ queue: preflighted, planId: 'plan-1', userConfirmed: true });
  assertEqual(approved.approvedScope.capabilities.join(','), 'workspace.read,workspace.write', 'approved scope is frozen');
  assertConversationProjection(parsed, preflighted.kernelPlanReview);

  assertParseFails(
    VALID_PLAN.replace('format="json"', 'format="yaml"'),
    'invalid_action_bundle_header',
    'YAML action bundle is rejected'
  );
  assertParseFails(
    VALID_PLAN.replace('"actions": [', '"unknownField": true, "actions": ['),
    'unknown_field',
    'unknown action bundle field is rejected'
  );
  assertParseFails(
    VALID_PLAN.replace('<REVIEW_GUIDE>', '<UNKNOWN_TAG>'),
    'unknown_tag',
    'unknown tags are rejected'
  );
  assertParseFails(
    VALID_PLAN.replace('"sourceBlockId": "CODE_BLOCK_example"', '"sourceBlockId": "missing"'),
    'missing_code_block_ref',
    'missing code block reference is rejected'
  );
  assertParseFails(
    `${VALID_PLAN}\n<CODE_BLOCK id="CODE_BLOCK_example" path="src/other.ts">duplicate</CODE_BLOCK>`,
    'duplicate_code_block',
    'duplicate code block ids are rejected'
  );
  assertParseFails(
    `${VALID_PLAN}\n<RESOURCE_REQUEST format="json" version="1">{"version":"1","id":"rr-1","reason":"need context","items":[]}</RESOURCE_REQUEST>`,
    'resource_request_with_action_bundle',
    'resource request and action bundle cannot appear in the same turn'
  );

  const withHints = parseAgentPlan(
    `${VALID_PLAN}\n<PERMISSION_HINTS>\nModel thinks write access may be needed.\n</PERMISSION_HINTS>`
  );
  assertEqual(withHints.permissionHints?.content.includes('write access'), true, 'permission hints remain advisory');
  assertEqual(
    compileActionBundleToPlanContract(withHints.actionBundle).requiredCapabilities.includes('Model thinks write access may be needed.'),
    false,
    'permission hints do not enter required capabilities'
  );

  assertNoExecutionFacts(parsed);
  assertPlanConfirmationPolicies(parsed);
  assertDynamicWorkflowProjection(parsed, preflighted.kernelPlanReview);
  assertResourceRequestLoop();
  assertPromptEnvelopeShape();
  await assertStage20CacheAndIndex();
}

function assertConversationProjection(
  parsed: AgentPlanParts,
  kernelPlanReview: NonNullable<ReturnType<typeof attachKernelPlanReview>['kernelPlanReview']>
): void {
  const cards = buildConversationProjection({
    sessionId: 'session-1',
    workflowPlan: selectDynamicWorkflow({
      workflowId: 'workflow-dev-1',
      requestKind: 'developmentTask',
      userRequest: 'Update one small workspace file.',
      isReadOnly: false,
      requiresExecution: true,
      needsMoreContext: false,
      hasKernelPlanReview: true,
      hasPermissionPrompt: true,
      hasExecutionFacts: true,
      hasReviewPacket: true,
    }),
    userRequest: 'Update one small workspace file.',
    agentPlan: parsed,
    kernelPlanReview,
    permissions: [
      {
        id: 'permission-1',
        capability: 'workspace.write',
        resourceScope: 'src/example.ts',
        decision: 'approved',
        summary: 'User approved workspace.write for src/example.ts.',
      },
    ],
    execution: [
      {
        id: 'tool-1',
        title: 'Read README',
        status: 'succeeded',
        toolName: 'fs.read',
      },
      {
        id: 'tool-2',
        title: 'Write file',
        status: 'succeeded',
        toolName: 'fs.write',
        modifiedFiles: ['src/example.ts'],
      },
    ],
    reviewPacket: buildReviewPacket({
      requirementId: 'req-1',
      runId: 'run-1',
      selfCheckInput: {
        userRequest: 'Update one small workspace file.',
        userPlan: parsed.userPlan,
        actionBundle: parsed.actionBundle,
        kernelPlanReview,
        permissionDecisions: [
          {
            id: 'permission-1',
            capability: 'workspace.write',
            resourceScope: 'src/example.ts',
            decision: 'approved',
            summary: 'User approved workspace.write for src/example.ts.',
          },
        ],
        toolResults: [
          {
            id: 'tool-1',
            title: 'Read README',
            status: 'succeeded',
            toolName: 'fs.read',
            modifiedFiles: [],
          },
          {
            id: 'tool-2',
            title: 'Write file',
            status: 'succeeded',
            toolName: 'fs.write',
            modifiedFiles: ['src/example.ts'],
          },
        ],
        validationCandidates: parsed.actionBundle.validationExpectations,
      },
      llmGuidance: {
        summary: 'Review the final diff before accepting.',
        finalSummary: 'Summary belongs to Review when ReviewPacket exists.',
        suggestedReviewChecks: ['Check src/example.ts'],
        knownRisks: [],
        unverifiedItems: [],
      },
      auditRefs: ['audit:1'],
      diffSummary: 'updated src/example.ts',
      permissionSummary: 'workspace.write approved',
    }),
    finalAnswer: 'Summary belongs to Review when ReviewPacket exists.',
    reasonSummaries: {
      plan_summary: 'The plan card explains what will happen before execution.',
      check_review: 'The check card separates plan approval from execution-time permission prompts.',
    },
    debugRefs: ['kernel:plan-review:1'],
    createdAt: '2026-06-04T00:00:00.000Z',
  });

  assertEqual(
    cards.map((card) => card.kind).join(','),
    'user_request,plan_summary,check_review,permission,execution_progress,review_summary',
    'conversation projection uses the expected card order'
  );
  assertEqual(cards.some((card) => card.kind === 'final_answer'), false, 'final answer merges into review when review packet exists');
  assertEqual(
    cards.find((card) => card.kind === 'review_summary')?.status,
    'waitingUserReview',
    'review packet waits for user review by default'
  );
  assertEqual(
    cards.find((card) => card.kind === 'plan_summary')?.collapsedReason?.title,
    '为什么这样做？',
    'reason summary is collapsed under the approved label'
  );

  const summaryExport = exportConversationProjection(cards, 'summary');
  assert(
    summaryExport.indexOf('## 用户请求') < summaryExport.indexOf('## Plan') &&
      summaryExport.indexOf('## Plan') < summaryExport.indexOf('## Check / 计划确认') &&
      summaryExport.indexOf('## Check / 计划确认') < summaryExport.indexOf('## Permission') &&
      summaryExport.indexOf('## Permission') < summaryExport.indexOf('## Execution') &&
      summaryExport.indexOf('## Execution') < summaryExport.indexOf('## Review'),
    'summary export order matches card order'
  );
  assert(!summaryExport.includes('为什么这样做？'), 'summary export keeps reason summary collapsed');

  const completeExport = exportConversationProjection(cards, 'complete');
  assert(completeExport.includes('为什么这样做？'), 'complete export can include collapsed reason summaries');

  const debugExport = exportConversationProjection(cards, 'debug');
  assert(debugExport.includes('kernel:plan-review:1'), 'debug export includes debug refs');

  const pendingReviewCards = buildConversationProjection({
    sessionId: 'session-1',
    userRequest: 'Update one small workspace file.',
    agentPlan: parsed,
    kernelPlanReview,
    execution: [
      {
        id: 'tool-1',
        title: 'Write file',
        status: 'succeeded',
        toolName: 'fs.write',
        modifiedFiles: ['src/example.ts'],
      },
    ],
    createdAt: '2026-06-04T00:00:00.000Z',
  });
  assertEqual(
    pendingReviewCards.map((card) => card.kind).join(','),
    'user_request,plan_summary,check_review,execution_progress,review_summary',
    'execution without review packet still creates a pending review card'
  );
  assertEqual(
    pendingReviewCards.find((card) => card.kind === 'review_summary')?.status,
    'pending',
    'pending review card is explicit'
  );
}

function assertNoExecutionFacts(parsed: AgentPlanParts): void {
  const serialized = JSON.stringify(parsed);
  assert(!serialized.includes('ValidationResult'), 'expected validation does not create ValidationResult facts');
  assert(!serialized.includes('ReviewGate accepted'), 'review guide does not create ReviewGate accepted facts');
}

function assertDynamicWorkflowProjection(
  parsed: AgentPlanParts,
  kernelPlanReview: NonNullable<ReturnType<typeof attachKernelPlanReview>['kernelPlanReview']>
): void {
  const answerWorkflow = selectDynamicWorkflow({
    workflowId: 'workflow-readonly-1',
    requestKind: 'readOnlyAnswer',
    userRequest: 'Explain the current file.',
    isReadOnly: true,
    requiresExecution: false,
    needsMoreContext: false,
    hasKernelPlanReview: false,
    hasPermissionPrompt: false,
    hasExecutionFacts: false,
    hasReviewPacket: false,
  });
  assertEqual(answerWorkflow.stateMachineBoundary, 'kernelOwnedStateMachine', 'state machine transition ownership stays in Kernel');
  assertEqual(answerWorkflow.requiresPlanReview, false, 'read-only answer can skip Kernel PlanReview preflight');
  assertEqual(answerWorkflow.usesKernelPermissionGate, false, 'read-only answer does not need PermissionGate');
  const answerCards = buildConversationProjection({
    sessionId: 'session-1',
    workflowPlan: answerWorkflow,
    userRequest: 'Explain the current file.',
    answer: 'This is a read-only answer.',
    createdAt: '2026-06-04T00:00:00.000Z',
  });
  assertEqual(answerCards.map((card) => card.kind).join(','), 'user_request,answer', 'read-only workflow projects as answer cards');

  const repairWorkflow = selectDynamicWorkflow({
    workflowId: 'workflow-repair-1',
    requestKind: 'repairLoop',
    userRequest: 'Fix the typecheck failure inside approved scope.',
    isReadOnly: false,
    requiresExecution: true,
    needsMoreContext: false,
    hasKernelPlanReview: true,
    hasPermissionPrompt: false,
    hasExecutionFacts: true,
    hasReviewPacket: false,
    repairAttempt: 1,
  });
  const repairCards = buildConversationProjection({
    sessionId: 'session-1',
    workflowPlan: repairWorkflow,
    userRequest: 'Fix the typecheck failure inside approved scope.',
    agentPlan: parsed,
    kernelPlanReview,
    execution: [
      {
        id: 'tool-1',
        title: 'Run typecheck',
        status: 'failed',
        toolName: 'test.command',
        error: 'type mismatch',
      },
    ],
    repairs: [
      {
        id: 'repair-1',
        title: 'Repair inside approved scope',
        status: 'running',
        reason: 'same approved file failed validation',
      },
    ],
    createdAt: '2026-06-04T00:00:00.000Z',
  });
  assertEqual(
    repairCards.map((card) => card.kind).join(','),
    'user_request,plan_summary,check_review,repair,execution_progress,review_summary',
    'repair workflow follows dynamic projection order without assuming a fixed four-state path'
  );
  assertEqual(
    repairCards.find((card) => card.kind === 'review_summary')?.status,
    'pending',
    'repair execution still requires Review pending when ReviewPacket is absent'
  );
}

function assertResourceRequestLoop(): void {
  const manifest: ResourceManifest = {
    id: 'manifest-1',
    workspaceScopeKey: 'workspace-1',
    workspaceId: 'workspace-1',
    budget: {
      maxEntries: 4,
      maxBytes: 4096,
    },
    defaultDenyPatterns: ['.git/**', '.deepcode/**', '**/*.secret'],
    entries: [
      {
        id: 'file-readme',
        kind: 'file',
        label: 'README',
        resourceRef: 'README.md',
        readPolicy: 'autoRead',
        reason: 'ordinary workspace read',
      },
      {
        id: 'private-git',
        kind: 'index',
        label: 'Git internals',
        resourceRef: '.git',
        readPolicy: 'askRead',
        reason: 'sensitive metadata',
      },
      {
        id: 'secret-config',
        kind: 'file',
        label: 'Secret config',
        resourceRef: '.env',
        readPolicy: 'denyRead',
        reason: 'secret-like path',
      },
    ],
  };
  const request: ResourceRequest = {
    id: 'resource-request-1',
    items: [
      { id: 'item-1', manifestEntryId: 'file-readme', reason: 'Need project overview.' },
      { id: 'item-2', manifestEntryId: 'private-git', reason: 'Need history details.' },
      { id: 'item-3', manifestEntryId: 'secret-config', reason: 'Need environment details.' },
      { id: 'item-4', manifestEntryId: 'missing-entry', reason: 'Model guessed a path.' },
    ],
  };
  const packet = createResourcePacket({ packetId: 'packet-1', request, manifest });
  assertEqual(packet.workspaceScopeKey, 'workspace-1', 'resource packets keep workspace ownership');
  assertEqual(packet.items[0]?.status, 'provided', 'auto read resources are provided');
  assertEqual(packet.items[1]?.status, 'needsUserApproval', 'sensitive resources require user approval');
  assertEqual(packet.items[2]?.status, 'denied', 'denied resources stay denied');
  assertEqual(packet.items[3]?.status, 'denied', 'resources outside ResourceManifest are denied');

  const resourceWorkflow = selectDynamicWorkflow({
    workflowId: 'workflow-resource-1',
    requestKind: 'resourceDiscovery',
    userRequest: 'Plan a change after reading project context.',
    isReadOnly: false,
    requiresExecution: true,
    needsMoreContext: true,
    hasKernelPlanReview: false,
    hasPermissionPrompt: false,
    hasExecutionFacts: false,
    hasReviewPacket: false,
    resourceManifest: manifest,
  });
  const cards = buildConversationProjection({
    sessionId: 'session-1',
    workflowPlan: resourceWorkflow,
    userRequest: 'Plan a change after reading project context.',
    resourceRequests: [request],
    resourcePackets: [packet],
    createdAt: '2026-06-04T00:00:00.000Z',
  });
  assertEqual(
    cards.map((card) => card.kind).join(','),
    'user_request,resource_request,resource_packet',
    'resource request loop stays inside the same Plan dialogue thread'
  );
  assertEqual(
    cards.find((card) => card.kind === 'resource_packet')?.status,
    'denied',
    'resource packet summarizes strongest read policy outcome'
  );

  const output = parseAgentPlanOutput(`<RESOURCE_REQUEST format="json" version="1">
{
  "version": "1",
  "id": "resource-request-2",
  "reason": "Need README before planning.",
  "items": [
    { "id": "item-1", "manifestEntryId": "file-readme", "reason": "Project overview." }
  ]
}
</RESOURCE_REQUEST>`);
  assertEqual(output.kind, 'resourceRequest', 'resource request only output is accepted as plan dialogue');
}

function assertPromptEnvelopeShape(): void {
  const envelope: PromptEnvelopeParts = {
    stablePrefix: {
      systemBoundary: 'LLM drafts; Session compiles; Kernel decides facts.',
      outputFormat: 'tagged markdown plus JSON ACTION_BUNDLE',
      jsonSchemaSummary: 'schema_version and additionalProperties=false equivalent validation',
      parserRules: 'unknown tags and unknown fields fail closed',
      capabilityCatalogSummary: 'workspace.read, workspace.write as proposal capabilities',
      workflowProjectionSchema: 'cards are projection semantics, not a fixed state path',
    },
    dynamicSuffix: {
      userRequest: 'Update a file.',
      contextCandidates: [],
      fileSnippets: [],
      toolEvidence: [],
    },
  };
  assertEqual(
    envelope.stablePrefix.workflowProjectionSchema.includes('projection semantics'),
    true,
    'prompt envelope stable prefix carries workflow projection schema'
  );

  const promptEnvelope = buildPromptEnvelope({
    workflowState: 'plan',
    allowedProposals: ['RequirementChecklist', 'ResourceRequest', 'ActionBundleDraft'],
    capabilityCatalogSummary: 'workspace.read is proposal-visible; authorization is separate.',
    userRequest: 'Update a file after review.',
  });
  assertEqual(promptEnvelope.stableLayerNames.join(','), 'baseSystem,workflowState,outputContract,capabilityProjection,memoryContext,userOverlay', 'prompt stable prefix layers are deterministic');
  assertEqual(promptEnvelope.dynamicLayerNames.join(','), 'currentRequirement,resourceContext', 'prompt dynamic suffix contains current context');
  assert(promptEnvelope.stablePrefix.includes('Do not output RESOURCE_REQUEST and ACTION_BUNDLE'), 'state prompt enforces exclusive plan outputs');
}

function assertPlanConfirmationPolicies(parsed: AgentPlanParts): void {
  const readOnlyBundle = {
    ...parsed.actionBundle,
    actions: parsed.actionBundle.actions.filter((action) => action.capability === 'workspace.read'),
  };
  const readOnlyDecision = decidePlanConfirmation({
    actionBundle: readOnlyBundle,
    kernelPlanReview: {
      planId: 'plan-read',
      status: 'autoAccepted',
      requiredCapabilities: ['workspace.read'],
      requiredPermissions: [],
      permissionGaps: [],
      hardFloorHits: [],
      deniedReasons: [],
      blockedReasons: [],
      findings: [],
      kernelGeneratedPermissionSummary: 'read only',
    },
    policy: {
      autoConfirmEnabled: true,
      allowedCapabilityTiers: ['read'],
    },
  });
  assertEqual(readOnlyDecision.decision, 'autoConfirmed', 'read-only plan can auto confirm when user enables read tier');

  const writeDecision = decidePlanConfirmation({
    actionBundle: parsed.actionBundle,
    kernelPlanReview: {
      planId: 'plan-write',
      status: 'awaitingTemporaryGrant',
      requiredCapabilities: ['workspace.read', 'workspace.write'],
      requiredPermissions: [],
      permissionGaps: ['workspace.write'],
      hardFloorHits: [],
      deniedReasons: [],
      blockedReasons: [],
      findings: [],
      kernelGeneratedPermissionSummary: 'write gap',
    },
    policy: {
      autoConfirmEnabled: true,
      allowedCapabilityTiers: ['read'],
    },
  });
  assertEqual(writeDecision.decision, 'requiresUserConfirmation', 'write plan still requires user confirmation without write auto tier');

  const deletePermission = decidePermissionAutoApproval({
    capability: 'workspace.delete',
    resourceScope: 'obsolete.txt',
    policy: { autoApproveRead: true },
  });
  assertEqual(deletePermission.decision, 'requiresUserConfirmation', 'delete requires an explicit auto-delete policy');

  const readPermission = decidePermissionAutoApproval({
    capability: 'workspace.read',
    resourceScope: 'README.md',
    policy: { autoApproveRead: true },
  });
  assertEqual(readPermission.decision, 'autoApproved', 'read permission can auto approve when enabled');

  const session = buildDynamicWorkflowSession({
    sessionId: 'session-1',
    requirementId: 'req-1',
    workflowId: 'workflow-read-1',
    requestKind: 'developmentTask',
    userRequest: 'Read README.',
    isReadOnly: true,
    requiresExecution: false,
    needsMoreContext: false,
    hasKernelPlanReview: true,
    hasPermissionPrompt: false,
    hasExecutionFacts: false,
    hasReviewPacket: false,
    actionBundle: readOnlyBundle,
    kernelPlanReview: {
      planId: 'plan-read',
      status: 'autoAccepted',
      requiredCapabilities: ['workspace.read'],
      requiredPermissions: [],
      permissionGaps: [],
      hardFloorHits: [],
      deniedReasons: [],
      blockedReasons: [],
      findings: [],
      kernelGeneratedPermissionSummary: 'read only',
    },
    planConfirmationPolicy: {
      autoConfirmEnabled: true,
      allowedCapabilityTiers: ['read'],
    },
  });
  assertEqual(session.autoConfirmDecision?.decision, 'autoConfirmed', 'dynamic session records auto confirmation decision');
  assert(session.approvedQueue, 'auto-confirmed read-only plan can freeze an approved queue');
}

async function assertStage20CacheAndIndex(): Promise<void> {
  const projectIndex = createProjectIndex({
    id: 'project-index-1',
    workspaceScopeKey: 'workspace-1',
    generatedAt: '2026-06-04T00:00:00.000Z',
    entries: [
      { id: 'b', kind: 'test', path: 'test.sh', summary: 'test entry', tags: ['test'] },
      { id: 'a', kind: 'manifest', path: 'package.json', summary: 'manifest', tags: ['manifest'] },
    ],
  });
  assertEqual(projectIndex.entries.map((entry) => entry.id).join(','), 'a,b', 'project index entries are sorted');
  const layering = deriveContextLayering({ projectIndex, initialKinds: ['manifest'], budgetBytes: 1024 });
  assertEqual(layering.workspaceScopeKey, 'workspace-1', 'context layering keeps workspace ownership');
  assertEqual(layering.initialPacketEntryIds.join(','), 'a', 'context layering selects initial manifest context');

  const promptA = canonicalizePrompt({
    provider: 'deepseek',
    model: 'deepseek-chat',
    templateVersion: 'prompt-v1',
    stablePrefix: { b: 2, a: 1 },
    dynamicSuffix: { request: 'hello' },
  });
  const promptB = canonicalizePrompt({
    provider: 'deepseek',
    model: 'deepseek-chat',
    templateVersion: 'prompt-v1',
    stablePrefix: { a: 1, b: 2 },
    dynamicSuffix: { request: 'hello' },
  });
  assertEqual(promptA.cacheHash, promptB.cacheHash, 'prompt cache hash is stable for key order changes');
  assertEqual(promptA.auditHash, promptB.auditHash, 'prompt audit hash is stable for key order changes');

  const toolsA = canonicalizeToolSchema([
    { name: 'z.tool', schema: { enum: ['b', 'a'], type: 'string' } },
    { name: 'a.tool', schema: { properties: { b: { type: 'string' }, a: { type: 'number' } } } },
  ]);
  const toolsB = canonicalizeToolSchema([
    { name: 'a.tool', schema: { properties: { a: { type: 'number' }, b: { type: 'string' } } } },
    { name: 'z.tool', schema: { type: 'string', enum: ['a', 'b'] } },
  ]);
  assertEqual(toolsA.toolsHash, toolsB.toolsHash, 'tool schema hash is stable across order changes');

  let now = 1000;
  const cache = new LocalL2Cache<string>(() => now);
  cache.set({ cacheKey: 'k1', response: 'value', ttlMs: 100, modelId: 'm', templateVersion: 'v1' });
  assertEqual(cache.get({ cacheKey: 'k1', templateVersion: 'v1' }).hit, true, 'local L2 cache hits before TTL');
  now = 1200;
  assertEqual(cache.get({ cacheKey: 'k1', templateVersion: 'v1' }).missReason, 'ttl_expired', 'local L2 cache expires by TTL');

  const strategy = applyProviderCacheStrategy({
    provider: 'deepseek',
    model: 'deepseek-chat',
    prefixHash: promptA.cacheHash,
    requestBody: { messages: [] },
  });
  assertEqual(strategy.semanticMode, 'deepseek-openai', 'DeepSeek strategy uses OpenAI-compatible semantic mode');
  assertEqual(typeof strategy.requestBody.prompt_cache_key, 'string', 'DeepSeek strategy injects prompt cache key');

  const telemetry = providerTelemetryFromUsage({
    provider: 'deepseek',
    usage: { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 2 },
    cacheHit: true,
  });
  assertEqual(telemetry.promptCacheHitTokens, 10, 'DeepSeek cache hit tokens are captured');

  const deduper = new SingleflightDeduper<number>();
  let calls = 0;
  const values = await Promise.all([
    deduper.run('same-key', async () => {
      calls += 1;
      return 1;
    }),
    deduper.run('same-key', async () => {
      calls += 1;
      return 2;
    }),
  ]);
  assertEqual(values.join(','), '1,1', 'singleflight shares the first result');
  assertEqual(calls, 1, 'singleflight calls factory once');
}

function assertParseFails(input: string, code: string, label: string): void {
  try {
    parseAgentPlan(input);
  } catch (error) {
    if (error instanceof AgentPlanParseError && error.code === code) {
      return;
    }
    throw new Error(`${label}: expected ${code}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label}: expected parser failure`);
}

function assertThrows(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `expected error to include ${expected}`);
    return;
  }
  throw new Error(`expected throw containing ${expected}`);
}

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

await main();
