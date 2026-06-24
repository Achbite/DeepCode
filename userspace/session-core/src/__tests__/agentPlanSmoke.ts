import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
} from '@deepcode/protocol';
import {
  agentConfigurableSettingsIndex,
  agentSettingsIndex,
  shellPreferenceSettingsIndex,
  workspaceOverridableSettingsIndex,
} from '@deepcode/protocol';
import {
  applyProviderCacheStrategy,
  assembleContext,
  buildNarrativeTimelineProjection,
  buildPromptEnvelope,
  buildResourcePromptContext,
  buildSessionMemoryDocument,
  buildSessionMemorySnapshot,
  buildSessionTaskGraph,
  collectUserGuidanceEvents,
  createResourcePacket,
  findLatestPendingPermission,
  parseProposalEnvelope,
  SessionDriver,
  SessionDriverLoop,
  type ActionBundleDraft,
  type ResourceManifest,
  type TranscriptEntry,
} from '../index.js';

async function main(): Promise<void> {
  assertV3Parser();
  assertLegacyProviderShapesAreRejected();
  assertActionBundleProtocolFields();
  assertPromptEnvelope();
  assertContextAssemblerCachePlan();
  assertResourcePromptBlocksStabilize();
  assertSessionMemoryDocument();
  assertSessionTaskGraphProjection();
  assertDeepSeekCacheStrategyDoesNotInjectRequestParameter();
  await assertProviderCacheTelemetryNormalizesBigModelUsage();
  await assertProviderTraceArchiveCompactsStreamingChunks();
  await assertProviderPartFramesEnterKernelDraftLedger();
  await assertAcceptedPlanStreamingDraftsAndJsonProgress();
  assertSettingsCatalogBoundaries();
  assertNarrativeTimelineProjection();
  assertImplementationPlanTaskProjectionProgress();
  assertSessionDriverSkeleton();
  await assertSessionDriverLoop();
  await assertSessionDriverLoopTerminalAnswerGuidanceRevision();
  await assertSessionDriverLoopTerminalGuidanceRevisionFallback();
  await assertSessionDriverLoopPathResourceRequest();
  await assertSessionDriverLoopSearchResourceRequest();
  await assertSessionDriverLoopRejectsOutsidePath();
  await assertSessionDriverLoopUsesRecentAttachmentRoot();
  await assertSessionDriverLoopReadOnlyRequestsContinueWithoutBudgetDecision();
  await assertSessionDriverLoopOldResourceBudgetDecisionStillResumes();
  await assertSessionDriverLoopProjectsDecisionRequest();
  await assertSessionDriverLoopRequirementChoiceEntersResumePrompt();
  await assertSessionDriverLoopProjectsTaskPlanBeforeComplete();
  await assertSessionDriverLoopRepairsSideEffectBundleEvidence();
  await assertSessionDriverLoopRepairsInvalidSourceBlock();
  await assertSessionDriverLoopCanonicalizesMissingSourceBlockId();
  await assertSessionDriverLoopRepairsAmbiguousSourceBlockId();
  await assertSessionDriverLoopRepairsEmptyDirectoryPlaceholderWrite();
  await assertSessionDriverLoopAllowsManyNoCodeActionsWithoutBatchRepair();
  await assertSessionDriverLoopAllowsManyCodeBlocksWithoutBatchRepair();
  await assertSessionDriverLoopRepairsOversizedActionBundle();
  await assertSessionDriverLoopRepairsEmptyActionBundleResponse();
  await assertSessionDriverLoopAcceptsLocalizedStructuredPlan();
  await assertSessionDriverLoopPlanRevisionReturnsToPlanning();
  await assertSessionDriverLoopPlanCardAcceptDoesNotNoopWithoutPlanReview();
  await assertSessionDriverLoopPlanCardAcceptExecutesReviewedDeletePlan();
  await assertSessionDriverLoopAcceptedPlanExecutesReviewedDeleteWithoutTaskTargets();
  await assertSessionDriverLoopAcceptedExecutionExceptionClosesRun();
  await assertSessionDriverLoopAcceptedExecutionKernelErrorClosesRun();
  await assertSessionDriverLoopAcceptedDecisionRecoversUnconsumedExecution();
  await assertSessionDriverLoopRequirementAcceptedActionBundleWaitsForExplicitPlanConfirmation();
  await assertSessionDriverLoopActionBundleAdmissionRepairsDirectoryDeleteBeforePlanCard();
  await assertSessionDriverLoopActionBundleAdmissionRejectsRepeatedDirectoryDelete();
  await assertSessionDriverLoopAcceptedScopeRejectsDirectoryDeleteFromResourceEvidence();
  await assertSessionDriverLoopAcceptedScopeExecutesReviewedDirectoryDelete();
  await assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesBatch();
  await assertSessionDriverLoopAcceptedImplementationPlanNormalizesWriteBatchForKernel();
  await assertSessionDriverLoopAcceptedImplementationPlanPrefersTargetPathOverRootResourceScope();
  await assertSessionDriverLoopAcceptedImplementationPlanRepairsPlanReviewRootAccessScope();
  await assertSessionDriverLoopAcceptedImplementationPlanPreservesExecutionRoot();
  await assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesMultiTargetBatch();
  await assertSessionDriverLoopAcceptedImplementationPlanSplitsCommaSeparatedTargets();
  await assertSessionDriverLoopAcceptedImplementationPlanAllowsBriefExecutionBatchPlan();
  await assertSessionDriverLoopAcceptedImplementationPlanKeepsContinuationNonExecutable();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsMergeIndependentTasks();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsScheduleExplicitDag();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsStreamPartFrames();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsStalledBranchFallback();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsDiscardFailedBranchAndFallback();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSerialFallbackProviderFailure();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsRepairInvalidParentFallback();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsTreatLegacyDependenciesAsSoftOrder();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSkipSingleModule();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSkipHardDependency();
  await assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesDeleteAction();
  await assertSessionDriverLoopAcceptedImplementationRejectsDeleteRootTarget();
  await assertSessionDriverLoopAcceptedImplementationPlanClassifiesDeleteCompileMismatch();
  await assertSessionDriverLoopAcceptedImplementationPlanClassifiesPatchEvidenceMismatch();
  await assertSessionDriverLoopAcceptedImplementationPlanContinuesUntilTasksComplete();
  await assertSessionDriverLoopAcceptedImplementationPlanReadsGeneratedArtifactEvidence();
  await assertSessionDriverLoopAcceptedImplementationPlanResumesFromResourceCursor();
  await assertSessionDriverLoopAcceptedImplementationPlanDoesNotInheritSubAgentAutoSetting();
  await assertSessionDriverLoopAcceptedImplementationPlanInheritsSubAgentOffSetting();
  await assertSessionDriverLoopAcceptedImplementationPlanAllowsPlannedProcessExecPermissionGate();
  await assertSessionDriverLoopAcceptedImplementationPlanAllowsAbsoluteAttachmentChildTarget();
  await assertSessionDriverLoopAcceptedImplementationRejectsAttachmentRootTarget();
  await assertSessionDriverLoopAcceptedImplementationPlanProjectsWorkUnitFailureReason();
  await assertSessionDriverLoopAcceptedImplementationRejectsOutOfScopeBatch();
  await assertSessionDriverLoopAcceptedPlanPatchRequestsSearchEvidence();
  await assertSessionDriverLoopAcceptedDecisionGroupsWorkspaceWriteGrants();
  await assertSessionDriverLoopAcceptedDecisionGrantsOutsideWorkspaceFileTargets();
  assertWorkflowStagePermissionProjectsPendingDecision();
  await assertSessionDriverLoopReviewRevisionReturnsToPlanning();
  await assertSessionDriverLoopReviewRevisionContinuesWhenAuditRunInactive();
  await assertSessionDriverLoopReviewAcceptAutoGeneratesNextPlan();
  await assertSessionDriverLoopReviewAcceptWithoutContinuationCompletesRun();
  await assertSessionDriverLoopReviewAcceptOffStopsAtCurrentBatch();
  await assertSessionDriverLoopRequirementRejectCancelsRun();
  await assertSessionDriverLoopRejectedDecisionCancelsRun();
  await assertSessionDriverLoopReviewRejectCancelsRun();
  await assertSessionDriverLoopPermissionRejectCancelsRun();
  await assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept();
  await assertSessionDriverLoopNativeReadToolStreamsThroughResourceResolve();
  await assertSessionDriverLoopNativeReadToolLoopHasNoFourRoundLimit();
  await assertSessionDriverLoopNativeReadToolDuplicateLoopRepairsToProposal();
  await assertSessionDriverLoopNativeReadToolDuplicateProposalWinsOverToolCall();
  await assertSessionDriverLoopNativeWriteToolTriggersImplementationPlanRepair();
  await assertSessionDriverLoopAcceptedPlanNativeWriteToolUsesProposalOnlyRepair();
}

async function assertSessionDriverLoopProjectsDecisionRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-requirement-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'decisionRequest',
        outputLanguage: 'en-US',
        decisionRequest: {
          version: '1',
          id: 'decision-generic-auto',
          reason: 'A generic user decision is required before planning.',
          summary: 'Choose how to proceed with the generic side-effect task.',
          options: [
            { id: 'recommended', label: 'Proceed', description: 'Generate the next reviewable plan.', recommended: true },
            { id: 'stop', label: 'Stop', description: 'Do not generate an implementation plan.' },
          ],
          allowsFreeform: true,
        },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-requirement-auto',
    content: 'Create a generic workspace change.',
  });
  assertEqual(llmCalls, 1, 'decisionRequest is produced by provider once');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'decisionRequest projects to a user intervention card');
  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, unknown> | undefined;
  assertEqual(confirmationPayload?.interactionOverlay, true, 'decisionRequest is projected as an interaction overlay');
  assertEqual(confirmationPayload?.parentRunId, confirmationPayload?.runId, 'decisionRequest overlay keeps the parent run id');
  assertEqual(confirmationPayload?.interactionRunId, confirmationPayload?.runId, 'decisionRequest overlay records the interaction run id');
  assertEqual(confirmationPayload?.sourceInteractionId, confirmationPayload?.requirementId, 'decisionRequest overlay records its source interaction id');
  assertEqual(
    String(confirmationPayload?.content ?? '').includes('## Options'),
    true,
    'decisionRequest renders as an option selection card'
  );
  assertEqual(
    JSON.stringify((confirmationPayload?.requirement as any)?.checklist?.explicitTasks ?? []).includes('Proceed'),
    false,
    'decisionRequest options are not copied into requirement checklist tasks'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'decisionRequest does not generate a plan before user decision');
}

async function assertSessionDriverLoopRequirementChoiceEntersResumePrompt(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'requirement-choice-waiting',
    sessionId: 'session-requirement-choice',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: 'Requirement confirmation',
      summary: 'Choose a generic test branch.',
      content: 'Choose a generic test branch.',
      originalUserRequest: 'Create a generic user intervention test.',
      runId: 'run-requirement-choice',
      requirementId: 'requirement-choice',
      status: 'waitingUserConfirmation',
      confirmable: true,
      decisionRequest: {
        id: 'decision-choice',
        question: 'Choose a generic branch.',
        options: [
          { id: 'alpha', label: 'Alpha branch', description: 'Continue with the first generic branch.', recommended: true },
          { id: 'beta', label: 'Beta branch', description: 'Continue with the second generic branch.' },
        ],
        allowsFreeform: true,
      },
    },
  }];
  const session: AgentSession = {
    id: 'session-requirement-choice',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Generic choice was received.' },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmRequests.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    guidance: [
      'Selected option:',
      '- id: alpha',
      '- label: Alpha branch',
    ].join('\n'),
    runId: 'run-requirement-choice',
    targetId: 'requirement-choice',
    existingEvents: events,
  });

  assertEqual(llmRequests.length, 1, 'accepted requirement choice resumes provider once');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('用户已完成用户介入选择'), 'resume prompt states that the user already selected an option');
  assert(promptText.includes('Alpha branch'), 'resume prompt includes the selected option label');
  assert(promptText.includes('不要重复输出同一个 decisionRequest'), 'resume prompt guards against repeating the same decision request');
}

async function assertSessionDriverLoopProjectsTaskPlanBeforeComplete(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  let proposalSubmits = 0;
  const session: AgentSession = {
    id: 'session-task-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericTaskPlanProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-task-plan',
    content: 'Create a generic multi-file workspace change.',
  });
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  const payload = planCard?.payload as Record<string, any> | undefined;
  assertEqual(llmCalls, 1, 'taskPlan is produced by provider once');
  assertEqual(proposalSubmits, 0, 'taskPlan does not submit executable Kernel ProposalSubmit before user confirmation');
  assertEqual(Boolean(payload?.taskPlan), true, 'taskPlan projects to a confirmable plan card');
  assertEqual(Array.isArray(payload?.codeBlocks) && payload.codeBlocks.length === 0, true, 'taskPlan plan card carries no source code');
  assertEqual(Boolean(payload?.actionBundle?.actions?.length), false, 'taskPlan plan card carries no executable actions');
}

function assertLegacyProviderShapesAreRejected(): void {
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'implementationPlan',
      outputLanguage: 'en-US',
      implementationPlan: {
        version: '1',
        id: 'impl-generic-canonical',
        title: 'Generic plan',
        summary: 'Plan generic workspace edits.',
        tasks: [],
      },
    }),
  }), 'unsupported: implementationPlan');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'actionBundle',
      outputLanguage: 'en-US',
      userPlanMarkdown: '# Plan\n\n## Summary\nGeneric plan.',
      codeBlocks: [],
      actionBundle: {
        version: '1',
        id: 'bundle-legacy-capability',
        goal: 'Generic workspace edit.',
        actions: [{
          actionId: 'write-generic',
          capability: 'fs.write',
          resourceScope: ['generic/output.txt'],
          description: 'Legacy capability action.',
        }],
        validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
        reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
      },
    }),
  }), 'capability is not provider-facing');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'actionBundle',
      outputLanguage: 'en-US',
      userPlanMarkdown: '# Plan\n\n## Summary\nGeneric plan.',
      codeBlocks: [{
        blockId: 'block-generic',
        targetPath: 'generic/output.txt',
        content: 'line 1\nline 2',
      }],
      actionBundle: {
        version: '1',
        id: 'bundle-legacy-content',
        goal: 'Generic workspace edit.',
        actions: [{
          actionId: 'write-generic',
          toolId: 'fs.write',
          args: { path: 'generic/output.txt', sourceBlockId: 'block-generic' },
          description: 'Canonical action.',
        }],
        validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
        reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
      },
    }),
  }), 'must use contentLines');

  const taskPlan = parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify(genericTaskPlanProposal()),
  });
  assertEqual(taskPlan.kind, 'taskPlan', 'taskPlan is the provider-facing non-executable plan kind');
  const taskPlanPayload = taskPlan.payload as Record<string, any>;
  assertEqual(Array.isArray(taskPlanPayload.tasks) && taskPlanPayload.tasks.length === 1, true, 'taskPlan carries task slices');
  assertEqual(Boolean(taskPlanPayload.actionBundle), false, 'taskPlan does not carry executable actionBundle');

  const invalidTaskPlan = genericTaskPlanProposal();
  (invalidTaskPlan.taskPlan as any).codeBlocks = [{ blockId: 'block-generic', contentLines: ['x'] }];
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic-plan',
    sessionId: 'session-generic-plan',
    raw: JSON.stringify(invalidTaskPlan),
  }), 'codeBlocks is not allowed');
}

function assertV3Parser(): void {
  const answer = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'answer',
      narration: 'This narration is ignored for final answer rendering.',
      outputLanguage: 'en-US',
      answer: { format: 'markdown', content: 'Generic answer.' },
    }),
  });
  assertEqual(answer.kind, 'answer', 'v3 answer parses');
  assertEqual(answer.runId, 'run-generic', 'v3 parser binds run id');
  assertEqual(answer.narration, 'This narration is ignored for final answer rendering.', 'v3 parser preserves optional narration');

  const resourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-path',
        reason: 'Need a generic file under the attached directory.',
        items: [{ id: 'path-item', rootId: 'root-generic', path: 'src/generic.txt', reason: 'Read generic source.' }],
      },
    }),
  });
  assertEqual(resourceRequest.kind, 'resourceRequest', 'v3 resourceRequest path item parses');
  const resourcePayload = resourceRequest.payload as any;
  assertEqual(resourcePayload.items[0].path, 'src/generic.txt', 'v3 resourceRequest keeps root-relative path');

  const aliasResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-alias',
        reason: 'Need a generic file using compatibility aliases.',
        resources: [{ id: 'alias-item', resourceType: 'file', rootId: 'root-generic', path: 'src/alias.txt', reason: 'Read alias source.' }],
      },
    }),
  });
  const aliasPayload = aliasResourceRequest.payload as any;
  assertEqual(aliasPayload.items[0].path, 'src/alias.txt', 'v3 resourceRequest resources[] alias canonicalizes to items[]');
  assertEqual(aliasPayload.items[0].kind, 'file', 'v3 resourceRequest resourceType alias canonicalizes to kind');

  const rangedResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-range',
        reason: 'Need a generic file segment.',
        items: [{ id: 'range-item', rootId: 'root-generic', path: 'src/generic.txt', offsetBytes: 12000, limitBytes: 6000, reason: 'Read a later generic segment.' }],
      },
    }),
  });
  const rangedPayload = rangedResourceRequest.payload as any;
  assertEqual(rangedPayload.items[0].offsetBytes, 12000, 'v3 resourceRequest preserves offsetBytes');
  assertEqual(rangedPayload.items[0].limitBytes, 6000, 'v3 resourceRequest preserves limitBytes');

  const searchResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-search',
        reason: 'Need generic search evidence.',
        items: [{
          id: 'search-item',
          kind: 'search',
          rootId: 'root-generic',
          query: 'generic anchor',
          include: ['src/'],
          contextLines: 2,
          maxResults: 25,
          reason: 'Find generic edit anchor.',
        }],
      },
    }),
  });
  const searchPayload = searchResourceRequest.payload as any;
  assertEqual(searchPayload.items[0].kind, 'search', 'v3 resourceRequest search item parses');
  assertEqual(searchPayload.items[0].query, 'generic anchor', 'v3 resourceRequest preserves search query');
  assertEqual(searchPayload.items[0].include[0], 'src/', 'v3 resourceRequest preserves include filter');
  assertEqual(searchPayload.items[0].contextLines, 2, 'v3 resourceRequest preserves contextLines');
  assertEqual(searchPayload.items[0].maxResults, 25, 'v3 resourceRequest preserves maxResults');

  const shorthandDecisionRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'decisionRequest',
      outputLanguage: 'en-US',
      reason: 'Need user choice for a generic boundary.',
      options: [
        { id: 'retry', label: 'Retry', description: 'Retry with the current accepted scope.' },
        { id: 'revise', label: 'Revise', description: 'Ask the user to revise the scope.' },
      ],
    }),
  });
  const decisionPayload = shorthandDecisionRequest.payload as any;
  assertEqual(decisionPayload.question, 'Need user choice for a generic boundary.', 'v3 decisionRequest shorthand is canonicalized to a question');
  assertEqual(decisionPayload.options.length, 2, 'v3 decisionRequest shorthand preserves valid options');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'decisionRequest',
      reason: 'Missing options should fail closed.',
    }),
  }), 'options must include 2-3 options');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'unsupported.protocol.schema',
      kind: 'answer',
      answer: { format: 'markdown', content: 'legacy' },
    }),
  }), 'deepcode.agent.protocol.v3');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      resourceRequest: {
        version: '1',
        id: 'invalid-resource-request',
        items: [{ id: 'missing-target', reason: 'Missing manifestEntryId and path.' }],
      },
    }),
  }), 'manifestEntryId, path, or kind="search"');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'reviewSummary',
      reviewSummary: { status: 'accepted', content: 'not provider output' },
    }),
  }), 'unsupported');
}

function assertActionBundleProtocolFields(): void {
  const bundle = genericActionBundle();
  assertEqual(bundle.actions.some((action) => action.capability === 'fs.write'), true, 'actionBundle carries fs.write capability');
  assertEqual(bundle.validationExpectations.length > 0, true, 'actionBundle carries validation expectations');
  assertEqual(bundle.reviewExpectations.length > 0, true, 'actionBundle carries review expectations');

  const proposal = parseProposalEnvelope({
    runId: 'run-normalize',
    sessionId: 'session-normalize',
    raw: JSON.stringify(providerFacingWriteProposalWithoutMachineIds()),
  });
  const payload = proposal.payload as any;
  assertEqual(payload.actionBundle.id, 'proposal-run-normalize-actionBundle-action-bundle', 'Session parser fills actionBundle id deterministically');
  assertEqual(payload.codeBlocks[0].id, 'generic-block', 'Session parser maps blockId to codeBlock id');
  assertEqual(payload.codeBlocks[0].path, 'generic-output.txt', 'Session parser maps targetPath to codeBlock path');
  assertEqual(payload.actionBundle.actions[0].id, 'write-generic-output', 'Session parser maps actionId to action id');
  assertEqual(payload.actionBundle.actions[0].title, 'Write generic output', 'Session parser maps description to action title');
  assertEqual(payload.actionBundle.actions[0].canParallelize, false, 'Session parser fills canParallelize default');
  assertEqual(payload.actionBundle.actions[0].conflictKeys[0], 'generic-output.txt', 'Session parser derives conflict key from resource scope');

  const missingToolActionRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  missingToolActionRaw.actionBundle = {
    ...missingToolActionRaw.actionBundle,
    actions: [{ actionId: 'missing-tool-action', description: 'Missing executable tool id.', args: { path: 'generic-output.txt' } }],
  };
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-action-missing-tool',
    raw: missingToolActionRaw,
  }), 'actions[0].toolId must be a non-empty Kernel catalog toolId');

  const continuationStringRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  continuationStringRaw.actionBundle = {
    ...continuationStringRaw.actionBundle,
    continuationExpectations: ['Continue with the next generic accepted slice.'],
  };
  const continuationStringProposal = parseProposalEnvelope({
    runId: 'run-continuation-string',
    sessionId: 'session-continuation-string',
    raw: continuationStringRaw,
  });
  assertEqual(
    ((continuationStringProposal.payload as any).actionBundle.continuationExpectations[0] as any).description,
    'Continue with the next generic accepted slice.',
    'string continuationExpectation is canonicalized to non-executable object form'
  );

  const continuationObjectRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  continuationObjectRaw.actionBundle = {
    ...continuationObjectRaw.actionBundle,
    continuationExpectations: [{ id: 'next-generic-slice', description: 'Continue with another generic target.', target: ['generic-next.txt'] }],
  };
  const continuationObjectProposal = parseProposalEnvelope({
    runId: 'run-continuation-object',
    sessionId: 'session-continuation-object',
    raw: continuationObjectRaw,
  });
  const continuationObject = ((continuationObjectProposal.payload as any).actionBundle.continuationExpectations[0] as any);
  assertEqual(continuationObject.description, 'Continue with another generic target.', 'object continuationExpectation does not require toolId');
  assertEqual(continuationObject.resourceScope[0], 'generic-next.txt', 'object continuationExpectation keeps target as review-only scope hint');

  const wrappedRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-actionbundle-payload-wrapper',
    sessionId: 'session-actionbundle-payload-wrapper',
    raw: {
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'actionBundle',
      outputLanguage: 'en-US',
      narration: 'Prepare a generic write batch.',
      payload: {
        userPlanMarkdown: wrappedRaw.userPlan,
        codeBlocks: wrappedRaw.codeBlocks,
        commandBlocks: wrappedRaw.commandBlocks ?? [],
        actionBundle: wrappedRaw.actionBundle,
        expectedValidation: wrappedRaw.expectedValidation,
        reviewGuide: wrappedRaw.reviewGuide,
      },
    },
  }), 'top-level field');

  const compatibilityRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  compatibilityRaw.actionBundle = {
    ...compatibilityRaw.actionBundle,
    validationExpectations: 'Kernel records a generic validation fact.',
    reviewExpectations: ['User reviews the generic action scope.'],
  };
  const compatibilityProposal = parseProposalEnvelope({
    runId: 'run-expectation-compat',
    sessionId: 'session-expectation-compat',
    raw: compatibilityRaw,
  });
  const compatibilityBundle = (compatibilityProposal.payload as any).actionBundle;
  assertEqual(
    compatibilityBundle.validationExpectations[0].description,
    'Kernel records a generic validation fact.',
    'string validationExpectation is canonicalized to object form'
  );
  assertEqual(
    compatibilityBundle.reviewExpectations[0].description,
    'User reviews the generic action scope.',
    'string[] reviewExpectations are canonicalized to object form'
  );

  const emptyExpectationRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  emptyExpectationRaw.actionBundle = {
    ...emptyExpectationRaw.actionBundle,
    validationExpectations: [''],
  };
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-empty-expectation',
    raw: emptyExpectationRaw,
  }), 'string value must be non-empty');

  const missingDescriptionRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  missingDescriptionRaw.actionBundle = {
    ...missingDescriptionRaw.actionBundle,
    reviewExpectations: [{ id: 'review-without-description' }],
  };
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-missing-expectation-description',
    raw: missingDescriptionRaw,
  }), 'description must be a non-empty string');

  const emptyContinuationRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  emptyContinuationRaw.actionBundle = {
    ...emptyContinuationRaw.actionBundle,
    continuationExpectations: [''],
  };
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-empty-continuation',
    raw: emptyContinuationRaw,
  }), 'continuationExpectations[0] string value must be non-empty');

  const missingContinuationDescriptionRaw = providerFacingWriteProposalWithoutMachineIds() as any;
  missingContinuationDescriptionRaw.actionBundle = {
    ...missingContinuationDescriptionRaw.actionBundle,
    continuationExpectations: [{ id: 'continuation-without-description' }],
  };
  assertThrows(() => parseProposalEnvelope({
    runId: 'run-missing-continuation-description',
    raw: missingContinuationDescriptionRaw,
  }), 'continuationExpectations[0].description must be a non-empty string');
}

function assertPromptEnvelope(): void {
  const manifest: ResourceManifest = {
    id: 'manifest-generic',
    workspaceScopeKey: 'workspace-generic',
    entries: [
      {
        id: 'attachment-0-generic-file',
        kind: 'file',
        label: 'File generic/file.txt',
        resourceRef: 'generic/file.txt',
        readPolicy: 'autoRead',
        reason: 'Explicit user attachment for the current user turn.',
      },
    ],
    budget: { maxEntries: 8, maxBytes: 8192 },
    defaultDenyPatterns: [],
  };
  const packet = createResourcePacket({
    packetId: 'packet-generic',
    manifest,
    request: {
      id: 'request-generic',
      items: [{ id: 'item-generic', manifestEntryId: 'attachment-0-generic-file', reason: 'Read attached resource.' }],
    },
    kernelEvidence: {
      'attachment-0-generic-file': {
        contentKind: 'fileText',
        promptContent: 'generic content',
        evidenceRefs: ['evidence-generic'],
      },
    },
  });
  packet.items[0].truncated = true;
  packet.items[0].originalBytes = 24000;
  const initialContext = {
    id: 'initial-generic',
    workspaceScopeKey: manifest.workspaceScopeKey,
    manifest,
  };
  const conversationRoots = [{
    rootId: 'attachment-0-generic-file',
    kind: 'directory' as const,
    label: 'Directory generic',
    displayPath: 'generic',
    absolutePath: '/tmp/generic',
    source: 'currentAttachment' as const,
    primary: true,
  }];
  const resourcePromptContext = buildResourcePromptContext({
    initialContext,
    conversationRoots,
    resourcePackets: [packet],
  });

  const prompt = buildPromptEnvelope({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
    capabilityCatalogSummary: 'fs.read\nfs.write',
    memoryHints: ['Recent user turn: generic request attachments=file:generic/file.txt'],
    userRequest: 'Analyze the attached resource.',
    initialContext,
    conversationRoots,
    resourcePromptContext,
  });
  assert(prompt.stablePrefix.includes('deepcode.agent.protocol.v3'), 'prompt enforces v3');
  assert(prompt.dynamicSuffix.includes('manifestEntry id=attachment-0-generic-file'), 'prompt exposes manifest entry ids');
  assert(prompt.dynamicSuffix.includes('Conversation roots'), 'prompt exposes conversation roots');
  assert(prompt.dynamicSuffix.includes('primary=true'), 'prompt marks the primary conversation root');
  assert(prompt.dynamicSuffix.includes('Primary conversation workspace root'), 'prompt exposes the primary workspace root');
  assert(prompt.dynamicSuffix.includes('targetPath/codeBlocks targetPath must be a concrete file path relative to the primary root'), 'prompt tells the model to avoid root-prefixed write paths');
  assert(prompt.stablePrefix.includes('rootId+path'), 'prompt documents path-based resourceRequest without long JSON examples');
  assert(prompt.stablePrefix.includes('optional top-level narration'), 'prompt documents model-generated narration');
  assert(prompt.stablePrefix.includes('reviewSummary is Session-generated'), 'prompt excludes reviewSummary from provider proposal kinds');
  assert(prompt.stablePrefix.includes('Implementation payload budget'), 'prompt documents payload-based implementation budget');
  assert(!prompt.stablePrefix.includes('implementationPlan top-level field'), 'prompt no longer documents implementationPlan as a provider kind');
  assert(prompt.stablePrefix.includes('actionBundle.actions[] are executable Kernel tool actions shaped {actionId,toolId,args,description,dependsOn?}'), 'prompt documents canonical action shape');
  assert(prompt.stablePrefix.includes('actionBundle.continuationExpectations[] are non-executable continuation notes shaped {id,description,target?,reason?,dependsOn?}'), 'prompt documents continuation as non-executable intent');
  assert(prompt.stablePrefix.includes('contentLines is the only provider-facing source-code content carrier'), 'prompt requires contentLines for source code');
  assert(prompt.stablePrefix.includes('Do not output capability, permissionLabels, accessScopes, or resourceScope'), 'prompt forbids provider-declared permissions');
  assert(prompt.stablePrefix.includes('Do not add a generic payload wrapper'), 'prompt tells provider not to wrap proposals in payload');
  assert(prompt.stablePrefix.includes('actionBundle proposal top-level fields'), 'prompt documents actionBundle top-level fields');
  assert(!prompt.stablePrefix.includes('payload object matching that kind'), 'prompt avoids payload wrapper wording');
  assert(!prompt.stablePrefix.includes('actionBundle payload:'), 'prompt avoids ambiguous actionBundle payload wording');
  assert(!prompt.stablePrefix.includes('at most 4 codeBlocks'), 'prompt does not impose a codeBlock count limit');
  assert(prompt.stablePrefix.includes('<systemStructure'), 'prompt includes the system structure layer');
  assert(prompt.stablePrefix.includes('black-box validation'), 'prompt treats tests as black-box validation');
  assert(prompt.stablePrefix.includes('Do not optimize for known tests'), 'prompt rejects test-specific optimization');
  assert(prompt.stablePrefix.includes('fixed prompts'), 'prompt forbids fixed prompt special-casing');
  assert(prompt.stablePrefix.includes('keyword branches'), 'prompt forbids keyword branches');
  assert(prompt.stablePrefix.includes('tokenizer branches'), 'prompt forbids tokenizer-specific branches');
  assert(prompt.stablePrefix.includes('example-specific branches'), 'prompt forbids example-specific logic');
  assert(prompt.stablePrefix.includes('<protectedStablePrefix'), 'prompt starts with explicit protected stable prefix boundary');
  assert(prompt.stableLayerNames[0] === 'protectedStablePrefix', 'protected stable prefix is the first stable layer');
  assert(!prompt.stablePrefix.includes('Current workflow state'), 'stable prefix excludes current workflow state');
  assert(!prompt.stablePrefix.includes('Recent user turn'), 'stable prefix excludes session-local memory hints');
  assert(!prompt.stablePrefix.includes('zh-CN'), 'stable prefix excludes localized JSON example payloads');
  assert(prompt.dynamicSuffix.includes('Current workflow state: needProposal'), 'dynamic suffix carries current workflow state');
  assert(prompt.dynamicSuffix.includes('Allowed proposals: answer, resourceRequest, actionBundle'), 'dynamic suffix carries allowed proposals');
  assert(prompt.dynamicSuffix.includes('fs.read'), 'dynamic suffix carries capability projection');
  assert(prompt.stableLayerNames.includes('projectMemory'), 'project memory index digest is an explicit stable context partition');
  assert(prompt.dynamicLayerNames.includes('projectMemoryRecall'), 'project memory recall is an explicit dynamic context partition');
  assert(prompt.dynamicLayerNames.includes('sessionMemory'), 'session memory is an explicit dynamic context partition');
  assert(prompt.dynamicLayerNames.includes('reusableResourceContext'), 'reusable resource context is separated from current request');
  assert(prompt.dynamicSuffix.includes('blockKey='), 'prompt includes stable resource block keys');
  assert(prompt.dynamicSuffix.includes('generic content'), 'prompt includes ResourcePacket content');
  assert(!prompt.dynamicSuffix.includes('evidence-generic'), 'prompt excludes volatile evidence refs from provider-visible resource context');
  assert(!prompt.dynamicSuffix.includes('Read-only resource budget:'), 'prompt does not expose fixed read-only resource budget');
  assert(prompt.dynamicSuffix.includes('not governed by a fixed Session round budget'), 'prompt explains read-only requests are user-controlled');
  assert(prompt.dynamicSuffix.includes('offsetBytes/limitBytes'), 'prompt hints range reread for truncated resources');
  assert(!prompt.dynamicSuffix.includes('auditOnlyContext'), 'audit-only context is not in dynamic suffix');
}

function assertSettingsCatalogBoundaries(): void {
  const sharedAgentKeys = new Set(agentSettingsIndex().map((entry) => entry.key));
  const guiPreferenceKeys = new Set(shellPreferenceSettingsIndex('gui').map((entry) => entry.key));
  const editorPreferenceKeys = new Set(shellPreferenceSettingsIndex('editor').map((entry) => entry.key));
  const workspaceKeys = new Set(workspaceOverridableSettingsIndex().map((entry) => entry.key));
  const agentConfigurableKeys = new Set(agentConfigurableSettingsIndex().map((entry) => entry.key));

  assertEqual(sharedAgentKeys.has('agent.permissions.gitPush'), true, 'Git push policy is a shared Agent setting');
  assertEqual(agentConfigurableKeys.has('agent.permissions.gitPush'), true, 'Agent can request shared Agent setting changes through audited config flow');
  assertEqual(guiPreferenceKeys.has('gui.colorTheme'), true, 'GUI preferences use the gui namespace');
  assertEqual(guiPreferenceKeys.has('workbench.colorTheme'), false, 'GUI preference index does not include editor workbench theme');
  assertEqual(editorPreferenceKeys.has('gui.colorTheme'), false, 'Editor preference index does not include GUI theme');
  assertEqual(workspaceKeys.has('agent.permissions.gitPush'), false, 'workspace overrides cannot change Agent security gates');
  assertEqual(workspaceKeys.has('ruler.rules'), true, 'workspace overrides may provide project-level Ruler additions');
}

function assertContextAssemblerCachePlan(): void {
  const manifest: ResourceManifest = {
    id: 'manifest-cache-generic',
    workspaceScopeKey: 'workspace-cache-generic',
    entries: [],
    budget: { maxEntries: 8, maxBytes: 8192 },
    defaultDenyPatterns: [],
  };
  const memoryDocument = buildSessionMemoryDocument([
    {
      id: 'memory-user',
      sessionId: 'session-cache',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze reusable context.' },
    },
  ]);
  const base = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'fs.read',
    userRequest: 'Summarize the reusable context.',
    memoryDocument,
    initialContext: {
      id: 'initial-cache-generic',
      workspaceScopeKey: manifest.workspaceScopeKey,
      manifest,
    },
    userGuidance: [{
      id: 'guidance-generic',
      content: 'Prefer a concise continuation and keep already observed facts unchanged.',
      source: 'user',
      checkpointKind: 'nextProviderCall',
    }],
    profile: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    templateVersion: 'cache-plan-test',
  });
  const followUp = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'fs.read',
    userRequest: 'Answer a follow-up from the same reusable context.',
    memoryDocument,
    initialContext: {
      id: 'initial-cache-generic',
      workspaceScopeKey: manifest.workspaceScopeKey,
      manifest,
    },
    profile: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    templateVersion: 'cache-plan-test',
  });

  assertEqual(base.cachePlan.deepseekPrefixCache.requestParameterRequired, false, 'DeepSeek cache plan does not require request parameters');
  assertEqual(base.cachePlan.cacheAffectsCorrectness, false, 'cache plan is observability only');
  assertEqual(base.cachePlan.contextAssemblyId, base.contextAssembly.contextAssemblyId, 'cache plan references the context assembly');
  assertEqual(base.cachePlan.providerCacheAttribution.cacheEligiblePrefixCharLength, base.prompt.stablePrefix.length, 'cache attribution records prefix char length');
  assertEqual(base.cachePlan.providerCacheAttribution.stableMessageHash, base.cachePlan.stablePrefixHash, 'cache attribution uses stable prefix hash');
  assertEqual(base.cachePlan.providerCacheAttribution.dynamicMessageHash, base.cachePlan.dynamicSuffixHash, 'cache attribution uses dynamic suffix hash');
  assert(base.cachePlan.providerCacheAttribution.changedPartitions.some((partition) => partition.name === 'ProjectMemory'), 'cache attribution includes project memory partition');
  assertEqual(base.cachePlan.stablePrefixHash, followUp.cachePlan.stablePrefixHash, 'same stable layers keep stable prefix hash');
  assert(base.cachePlan.dynamicSuffixHash !== followUp.cachePlan.dynamicSuffixHash, 'current request changes dynamic suffix hash');
  assert(base.cachePlan.cacheHash !== followUp.cachePlan.cacheHash, 'overall cache hash changes with the dynamic suffix');
  assert(!base.prompt.stablePrefix.includes('Summarize the reusable context.'), 'stable prefix excludes current user request');
  assert(base.prompt.dynamicSuffix.includes('Summarize the reusable context.'), 'dynamic suffix carries current user request');
  assert(base.prompt.dynamicSuffix.includes('Prefer a concise continuation'), 'user guidance enters the dynamic suffix');
  assertEqual(base.contextAssembly.userGuidanceCount, 1, 'context assembly records provider-checkpoint user guidance count');
  assertEqual(base.contextAssembly.consumedUserGuidanceIds[0], 'guidance-generic', 'context assembly records consumed user guidance ids');
  assertEqual(base.contextAssembly.schemaVersion, 'deepcode.session.context-assembly.v3', 'context assembly records v3 partitioned cache debug schema');
  assertEqual(base.contextAssembly.promptPolicyVersion, 'deepcode.prompt-policy.v1', 'context assembly records the prompt policy version without bumping schema');
  assertEqual(base.contextAssembly.cacheAffectsCorrectness, false, 'context assembly cache telemetry is observability only');
  assertEqual(base.contextAssembly.catalogHash, followUp.contextAssembly.catalogHash, 'same capability catalog keeps catalog hash stable');
  assert(base.contextAssembly.stateContractHash === followUp.contextAssembly.stateContractHash, 'same workflow state and allowed proposals keep state contract hash stable');
  assertEqual(base.contextAssembly.budgetPlan.contextWindowTokens, 1_000_000, 'context assembly records 1M soft context budget');
  assertEqual(base.contextAssembly.budgetPlan.maxOutputTokens, 384_000, 'context assembly records 384K output reserve');
  assertEqual(base.contextAssembly.reservedOutputTokens, 384_000, 'context assembly records reserved output tokens');
  assertEqual(base.contextAssembly.budgetPlan.projectMemoryBudgetTokens, 128_000, 'context assembly records 128K project memory soft cap');
  assertEqual(base.contextAssembly.budgetPlan.sessionMemoryBudgetTokens, 256_000, 'context assembly records 256K session memory soft cap');
  assertEqual(base.contextAssembly.memoryCompressionMode, 'memory-v3-soft-cap-lines', 'context assembly records current memory compression mode');
  assertEqual(base.contextAssembly.evidenceFreshnessMode, 'resource-evidence-tail-v1', 'context assembly records current evidence freshness mode');
  assert(base.contextAssembly.projectMemoryArchiveHash, 'context assembly records project memory archive hash');
  assert(base.contextAssembly.sessionMemoryArchiveHash, 'context assembly records session memory archive hash');
  assert(base.contextAssembly.expandedMemoryItemIds?.length, 'context assembly records expanded memory item ids');
  assert(base.contextAssembly.memoryDroppedReasonCounts?.retained !== undefined, 'context assembly records memory dropped reason counts');
  assertEqual(base.contextAssembly.traceArchiveMode, 'compact-provider-trace', 'context assembly records compact trace archive mode');
  assertEqual(base.contextAssembly.resourceBlocks.length, 0, 'simple chat path has no resource blocks');
  assertEqual(base.contextAssembly.resourceFullTextCharCount, 0, 'simple chat path has no full resource text');
  assertEqual(base.contextAssembly.resourceEvidenceTailCount, 0, 'simple chat path has no resource evidence tail entries');
  assertEqual(base.contextAssembly.providerVisibleTokenEstimate, base.contextAssembly.partitionTokenEstimates.providerVisibleTotal, 'provider visible token estimate mirrors partition total');
  assert(base.contextAssembly.partitionCharCounts.protectedPrefix > 0, 'context assembly records protected prefix partition');
  assert(base.contextAssembly.partitionCharCounts.projectMemory > 0, 'context assembly records project memory partition');
  assert(base.contextAssembly.partitionCharCounts.sessionMemory > 0, 'context assembly records session memory partition');
  assert(base.contextAssembly.partitionCharCounts.intentMemory > 0, 'context assembly records intent/memory partition');
  const partitionNames = base.contextAssembly.partitionRecords.map((partition) => partition.name);
  assertEqual(partitionNames.join(','), [
    'PlatformProtocolContract',
    'AgentOperatingContract',
    'StaticToolCatalogDigest',
    'UserRulerAndProjectInstructions',
    'ProjectMemory',
    'SessionMemory',
    'CurrentRunStateAndRequest',
    'EvidenceTail',
    'AuditOnly',
  ].join(','), 'context assembly records the formal prompt partitions in stable order');
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'PlatformProtocolContract')?.segmentNames.includes('protocolContract') === true,
    'platform protocol partition contains the protocol contract segment'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'ProjectMemory')?.segmentNames.includes('projectMemoryRecall') === true,
    'project memory partition includes dynamic recall segment'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'EvidenceTail')?.segmentNames.includes('reusableResourceContext') === true,
    'evidence tail partition contains reusable resource context'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'AuditOnly')?.providerVisible === false,
    'audit-only partition is not provider visible'
  );
  assert(base.contextAssembly.segments.find((segment) => segment.name === 'reusableResourceContext')?.charLength ?? 0 < 1200, 'empty resource context stays small');
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.cacheClass === 'globalStable' && segment.stablePrefix),
    true,
    'context assembly records stable protocol segments'
  );
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.cacheClass === 'reusableResource' && segment.name === 'reusableResourceContext'),
    true,
    'context assembly records reusable resource segment'
  );
  const reusableIndex = base.prompt.dynamicLayerNames.indexOf('reusableResourceContext');
  const requirementIndex = base.prompt.dynamicLayerNames.indexOf('currentRequirement');
  const currentResourceIndex = base.prompt.dynamicLayerNames.indexOf('currentResourceResults');
  assert(reusableIndex > requirementIndex, 'reusable resource evidence appears after current request in the dynamic suffix');
  assert(currentResourceIndex > reusableIndex, 'current resource policy and tool results remain at the evidence tail');
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.auditOnly && segment.cacheClass === 'auditOnly'),
    true,
    'audit-only segment is tracked separately from cache prefix'
  );
}

function assertResourcePromptBlocksStabilize(): void {
  const alphaMiddleMarker = 'ALPHA_MIDDLE_SHOULD_NOT_REPEAT_AFTER_SUMMARY';
  const alphaContent = `${'alpha-head '.repeat(90)}${alphaMiddleMarker}${' alpha-tail'.repeat(90)}`;
  const betaContent = 'beta current resource content';
  const manifest: ResourceManifest = {
    id: 'manifest-resource-blocks',
    workspaceScopeKey: 'workspace-resource-blocks',
    entries: [
      {
        id: 'alpha-file',
        kind: 'file',
        label: 'File src/alpha.txt',
        resourceRef: 'src/alpha.txt',
        readPolicy: 'autoRead',
        reason: 'Generic prior file.',
      },
      {
        id: 'beta-file',
        kind: 'file',
        label: 'File src/beta.txt',
        resourceRef: 'src/beta.txt',
        readPolicy: 'autoRead',
        reason: 'Generic current file.',
      },
    ],
    budget: { maxEntries: 8, maxBytes: 64000 },
    defaultDenyPatterns: [],
  };
  const initialContext = {
    id: 'initial-resource-blocks',
    workspaceScopeKey: manifest.workspaceScopeKey,
    manifest,
  };
  const alphaPacket = createResourcePacket({
    packetId: 'packet-alpha-volatile',
    manifest,
    request: {
      id: 'request-alpha-volatile',
      items: [{ id: 'item-alpha', manifestEntryId: 'alpha-file', reason: 'Read alpha.' }],
    },
    kernelEvidence: {
      'alpha-file': {
        contentKind: 'fileText',
        promptContent: alphaContent,
        evidenceRefs: ['volatile-evidence-alpha'],
      },
    },
  });
  const betaPacket = createResourcePacket({
    packetId: 'packet-beta-volatile',
    manifest,
    request: {
      id: 'request-beta-volatile',
      items: [{ id: 'item-beta', manifestEntryId: 'beta-file', reason: 'Read beta.' }],
    },
    kernelEvidence: {
      'beta-file': {
        contentKind: 'fileText',
        promptContent: betaContent,
        evidenceRefs: ['volatile-evidence-beta'],
      },
    },
  });

  const first = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'fs.read',
    userRequest: 'Analyze alpha.',
    initialContext,
    resourcePackets: [alphaPacket],
    profile: { provider: 'deepseek', model: 'deepseek-chat' },
    templateVersion: 'resource-block-test',
  });
  const second = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'fs.read',
    userRequest: 'Analyze beta with prior alpha context.',
    initialContext,
    resourcePackets: [alphaPacket, betaPacket],
    profile: { provider: 'deepseek', model: 'deepseek-chat' },
    templateVersion: 'resource-block-test',
  });

  const firstAlpha = first.contextAssembly.resourceBlocks.find((block) => block.displayRef === 'src/alpha.txt');
  const secondAlpha = second.contextAssembly.resourceBlocks.find((block) => block.displayRef === 'src/alpha.txt');
  const secondBeta = second.contextAssembly.resourceBlocks.find((block) => block.displayRef === 'src/beta.txt');
  assert(firstAlpha, 'first alpha block exists');
  assert(secondAlpha, 'second alpha block exists');
  assert(secondBeta, 'second beta block exists');
  if (!firstAlpha || !secondAlpha || !secondBeta) throw new Error('resource block test setup failed');
  assertEqual(firstAlpha.blockKey, secondAlpha.blockKey, 'old resource block keeps stable key across later packets');
  assertEqual(firstAlpha.contentHash, secondAlpha.contentHash, 'old resource block keeps stable content hash across later packets');
  assertEqual(firstAlpha.retention, 'full', 'latest small resource can be full text');
  assertEqual(secondAlpha.retention, 'summary', 'old resource is downgraded to summary after a newer packet');
  assertEqual(secondBeta.retention, 'full', 'new current small resource remains full text');
  assertEqual(secondAlpha.volatileFieldStripped, true, 'resource block records volatile field stripping');
  assert(second.prompt.dynamicSuffix.includes(betaContent), 'current resource full text remains available');
  assert(!second.prompt.dynamicSuffix.includes(alphaMiddleMarker), 'old resource middle content is not repeatedly carried after summary downgrade');
  assert(!second.prompt.dynamicSuffix.includes('volatile-evidence-alpha'), 'volatile evidence refs are not provider-visible');
  assert(!second.prompt.dynamicSuffix.includes('packet-alpha-volatile'), 'volatile packet ids are not provider-visible');
  assert(second.contextAssembly.resourceFullTextCharCount < first.contextAssembly.resourceFullTextCharCount + betaContent.length, 'full resource text budget does not grow by repeating old full text');
}

function assertSessionMemoryDocument(): void {
  const document = buildSessionMemoryDocument([
    {
      id: 'memory-user',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: {
        content: 'Analyze a generic attachment.',
        attachments: [{ kind: 'directory', path: 'generic-attachment', scope: 'message' }],
      },
    },
    {
      id: 'memory-plan',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: { summary: 'Read a generic overview before proposing changes.' },
    },
    {
      id: 'memory-tool',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result',
      payload: {
        toolName: 'fs.read',
        summary: 'Read a generic source file.',
        output: {
          items: [{
            manifestEntryId: 'entry-generic',
            contentKind: 'fileText',
            absolutePath: '/tmp/generic/source.txt',
          }],
        },
      },
    },
    {
      id: 'memory-review',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'review_summary',
      payload: {
        status: 'accepted',
        content: 'The generic batch is accepted.',
        facts: ['Kernel recorded the generic write fact.'],
      },
    },
    {
      id: 'memory-answer',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'assistant_msg',
      payload: {
        channel: 'final',
        content: 'A long generic final answer that should be summarized as short-term continuity rather than stable execution fact.',
      },
    },
  ]);

  assertEqual(document.schemaVersion, '3', 'memory document is versioned');
  assert(document.intentContext.some((item) => item.includes('Current user request')), 'memory records user intent');
  assert(document.intentContext.some((item) => item.includes('Plan checkpoint')), 'memory records plan intent as intent context');
  assert(document.factContext.some((item) => item.includes('Tool result summary: fs.read')), 'memory records tool summaries as evidence tail facts');
  assert(document.factContext.some((item) => item.includes('ResourcePacket handle')), 'memory records resource packet handles');
  assertEqual(document.factContext.some((item) => item.includes('Kernel recorded the generic write fact')), false, 'raw review facts do not enter memory fact context');
  assert(document.archiveMetadata?.auditOnlyContext.some((item) => item.includes('Review raw facts retained in audit only')), 'raw review facts are retained as audit-only handles');
  assert(document.decisionContext.some((item) => item.includes('Review accepted')), 'memory records compact review decisions');
  assert(document.resourceContext.some((item) => item.includes('Project resource handle')), 'memory records reusable attachment facts');
  assert(document.longTermContext.some((item) => item.includes('Project resource handle')), 'stable memory records reusable attachment facts');
  assert(document.shortTermContext.some((item) => item.includes('Plan checkpoint')), 'short-term memory records active planning intent');
  assert(document.projectMemoryItems.length > 0, 'project memory is backed by MemoryItemV4 items');
  assert(document.sessionMemoryItems.length > 0, 'session memory is backed by MemoryItemV4 items');
  assert(document.projectMemoryItems.every((item) => item.scope === 'project'), 'project memory items keep project scope');
  assert(document.sessionMemoryItems.every((item) => item.scope === 'session'), 'session memory items keep session scope');
  assert(document.projectMemoryItems.some((item) => item.authority === 'resourcePacket'), 'project memory records resourcePacket authority');
  assert(document.sessionMemoryItems.some((item) => item.kind === 'intent'), 'session memory records active session intent items');
  assert(document.projectMemoryContext.every((item) => item.includes('sourceRefs=') && !item.includes('sourceRefs=synthetic:none')), 'project memory items carry event source refs');
  assert(document.sessionMemoryContext.some((item) => item.includes('sourceRefs=') && item.includes('compression=')), 'session memory renders source refs and compression');
  assert(document.shortTermContext.some((item) => item.includes('Assistant final summary')), 'assistant finals are summarized as short-term context');
  assertEqual(document.intentContext.some((item) => item.includes('Assistant final')), false, 'assistant final text is not promoted as stable intent');
  assertEqual(document.factContext.some((item) => item.includes('Plan intent')), false, 'plan intent does not enter factContext');

  const snapshot = buildSessionMemorySnapshot([
    {
      id: 'memory-user',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze a generic attachment.' },
    },
  ], { sessionId: 'session-memory', generatedAt: '2026-01-01T00:00:10.000Z' });
  assertEqual(snapshot.schemaVersion, 'deepcode.session.memory-snapshot.v1', 'memory snapshot has a read-model schema');
  assertEqual(snapshot.sessionId, 'session-memory', 'memory snapshot records the source session id');
  assertEqual(snapshot.softCaps.projectMemoryTokens, 128000, 'project memory snapshot exposes project soft cap');
  assertEqual(snapshot.softCaps.sessionMemoryTokens, 256000, 'session memory snapshot exposes session soft cap');
  assertEqual(snapshot.metadata.freshnessMode, 'compiledFromSessionEvents', 'memory snapshot is compiled from session events');
  assertEqual(snapshot.metadata.archiveDescriptor.logicalSessionPath.includes('session-memory'), true, 'memory snapshot exposes user-visible session archive path');
  assertEqual(snapshot.metadata.archiveSidecar.schemaVersion, 'deepcode.session.memory-archive-sidecar.v1', 'memory snapshot exposes archive sidecar read model');
  assert(snapshot.metadata.sessionMarkdownPreview.includes('Session Memory'), 'memory snapshot exposes markdown preview');

  const guidance = collectUserGuidanceEvents([
    {
      id: 'guidance-event',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:05.000Z',
      kind: 'user_guidance',
      payload: {
        content: 'Use the existing facts before asking for more resources.',
        runId: 'run-guidance',
      },
    },
  ], 'run-guidance');
  assertEqual(guidance.length, 1, 'user guidance events are collected for the next provider checkpoint');
  assertEqual(guidance[0]?.checkpointKind, 'nextProviderCall', 'guidance is scheduled for the next provider call');
}

function assertSessionTaskGraphProjection(): void {
  const events: AgentEvent[] = [
    {
      id: 'task-requirement',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: { status: 'pending', summary: 'Confirm a generic requirement.' },
    },
    {
      id: 'task-requirement-decision',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'requirement_decision',
      payload: { decision: 'accept', summary: 'Proceed with the generic requirement.' },
    },
    {
      id: 'task-tool-call',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_call',
      payload: { toolName: 'fs.list', callId: 'list-generic', summary: 'List generic resources.' },
    },
    {
      id: 'task-tool-result',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'tool_result',
      payload: { toolName: 'fs.list', callId: 'list-generic', status: 'completed', summary: 'Listed generic resources.' },
    },
    {
      id: 'task-plan',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'plan_card',
      payload: { summary: 'Plan a generic reviewable batch.' },
    },
    {
      id: 'task-permission',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:05.000Z',
      kind: 'permission_request',
      payload: { status: 'pending', summary: 'User decision is required.' },
    },
    {
      id: 'task-review',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:06.000Z',
      kind: 'review_summary',
      payload: {
        status: 'waitingUserReview',
        content: 'Review a generic batch.',
        continuations: [{ id: 'continue-generic', title: 'Continue generic work.' }],
      },
    },
    {
      id: 'task-guidance-queued',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:06.500Z',
      kind: 'user_guidance',
      payload: {
        content: 'Use the already collected facts before requesting more resources.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'queued',
      },
    },
    {
      id: 'task-guidance-consumed',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:06.750Z',
      kind: 'user_guidance',
      payload: {
        content: 'Prefer a concise final answer.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'consumed',
      },
    },
    {
      id: 'task-answer',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:07.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'final', content: 'Generic final answer.' },
    },
  ];
  const graph = buildSessionTaskGraph({
    sessionId: 'session-task',
    runId: 'run-task',
    events,
    stateContract: {
      runId: 'run-task',
      stateId: 'needProposal',
      stateKind: 'driverRequest',
      allowedInputs: ['proposalSubmit'],
      allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
      proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
      capabilityProjection: ['fs.read'],
    },
    driverRequest: {
      id: 'driver-task',
      runId: 'run-task',
      sessionId: 'session-task',
      kind: 'needProposal',
      reason: 'Need a generic proposal.',
    },
  });

  assertEqual(graph.schemaVersion, '1', 'task graph is versioned');
  assertEqual(graph.stateContractRef?.stateId, 'needProposal', 'task graph carries state contract refs');
  assertEqual(graph.driverRequestRef?.id, 'driver-task', 'task graph carries driver request refs');
  assertEqual(taskStatus(graph, 'requirement'), 'completed', 'requirement task completes after user decision');
  assertEqual(taskStatus(graph, 'resource-list-generic'), 'completed', 'resource task completes after tool result');
  assertEqual(taskStatus(graph, 'waiting-user'), 'waiting', 'permission task waits for user input');
  assertEqual(taskStatus(graph, 'review'), 'running', 'waiting review remains visible as active work');
  assertEqual(taskStatus(graph, 'continuation'), 'queued', 'continuation intent is queued after review facts');
  assertEqual(taskStatus(graph, 'guidance-task-guidance-queued'), 'queued', 'pending guidance is queued before provider consumption');
  assertEqual(taskStatus(graph, 'guidance-task-guidance-consumed'), 'completed', 'consumed guidance is completed after provider checkpoint');
  assertEqual(taskStatus(graph, 'analysis'), 'completed', 'final answer completes analysis task');
}

function assertDeepSeekCacheStrategyDoesNotInjectRequestParameter(): void {
  const result = cacheStrategyResult('deepseek', 'deepseek-chat');
  assertEqual(result.semanticMode, 'deepseek-openai', 'DeepSeek keeps OpenAI-compatible semantic mode');
  assertEqual(result.serverPromptCacheSupported, true, 'DeepSeek server prompt cache is marked as supported');
  assertEqual(Object.prototype.hasOwnProperty.call(result.requestBody, 'prompt_cache_key'), false, 'DeepSeek request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(result.requestBody, 'cache_control'), false, 'DeepSeek request body does not include cache_control');
  const openai = cacheStrategyResult('openai', 'gpt-generic');
  assertEqual(openai.semanticMode, 'openai', 'OpenAI keeps OpenAI semantic mode');
  assertEqual(Object.prototype.hasOwnProperty.call(openai.requestBody, 'prompt_cache_key'), false, 'OpenAI request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(openai.requestBody, 'cache_control'), false, 'OpenAI request body does not include cache_control');
  const anthropic = cacheStrategyResult('anthropic-native', 'claude-generic');
  assertEqual(anthropic.semanticMode, 'anthropic-native', 'Anthropic native keeps Anthropic semantic mode');
  assertEqual(Object.prototype.hasOwnProperty.call(anthropic.requestBody, 'prompt_cache_key'), false, 'Anthropic request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(anthropic.requestBody, 'cache_control'), false, 'Anthropic request body does not include cache_control');
}

function cacheStrategyResult(provider: string, model: string): ReturnType<typeof applyProviderCacheStrategy> {
  return applyProviderCacheStrategy({
    provider,
    model,
    prefixHash: 'fnv1a32:generic',
    requestBody: {
      model,
      messages: [{ role: 'user', content: 'generic' }],
    },
  });
}

async function assertProviderCacheTelemetryNormalizesBigModelUsage(): Promise<void> {
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: 'session-cache-bigmodel',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => ({
      ok: true,
      data: {
        chunks: [{ type: 'done' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          prompt_tokens_details: {
            cached_tokens: 77,
          },
        },
        assistantMessage: {
          role: 'assistant',
          content: JSON.stringify({
            schemaVersion: 'deepcode.agent.protocol.v3',
            kind: 'answer',
            outputLanguage: 'en-US',
            answer: { format: 'markdown', content: 'Generic answer.' },
          }),
        },
      },
    }),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-cache-bigmodel',
    content: 'Answer a generic question.',
    requirementConfirmationMode: 'off',
  });
  const telemetry = result.events.find((event) => event.kind === 'cache_telemetry');
  if (!telemetry) throw new Error('cache telemetry should be emitted for provider usage');
  const payload = telemetry.payload as any;
  assertEqual(payload.promptCacheHitTokens, 77, 'BigModel prompt_tokens_details.cached_tokens maps to cache hit tokens');
  assertEqual(payload.promptCacheMissTokens, 923, 'BigModel cache miss tokens are inferred from prompt tokens minus cached tokens');
  assertEqual(payload.cachedTokens, 77, 'BigModel cached token detail is preserved');
  assert(Array.isArray(payload.promptSegmentDigests) && payload.promptSegmentDigests.length > 0, 'cache telemetry includes prompt segment digests');
}

async function assertProviderTraceArchiveCompactsStreamingChunks(): Promise<void> {
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  const session: AgentSession = {
    id: 'session-trace-archive',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const chunks: LlmChatResult['chunks'] = [];
  for (let index = 0; index < 5000; index += 1) {
    chunks.push({
      type: index % 5 === 0 ? 'reasoning_delta' : 'delta',
      content: `generic stream fragment ${index} ${'x'.repeat(80)}`,
      rawProvider: {
        id: `raw-provider-${index}`,
        payload: `raw-provider-payload-${index}-${'y'.repeat(200)}`,
      },
    });
  }
  chunks.push({
    type: 'done',
    finishReason: 'stop',
    usage: { promptTokens: 1000, completionTokens: 384000, totalTokens: 385000 },
    rawProvider: { id: 'raw-provider-done', payload: 'raw-provider-payload-done' },
  });

  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    appendTranscript: async (_sessionId, entry) => {
      transcript.push(entry);
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => ({
      ok: true,
      data: {
        chunks,
        usage: { promptTokens: 1000, completionTokens: 384000, totalTokens: 385000 },
        assistantMessage: {
          role: 'assistant',
          reasoningContent: 'generic reasoning '.repeat(1000),
          content: JSON.stringify({
            schemaVersion: 'deepcode.agent.protocol.v3',
            kind: 'answer',
            outputLanguage: 'en-US',
            answer: { format: 'markdown', content: 'Generic compact trace answer.' },
          }),
        },
      },
    }),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + transcript.length + 1}`,
  });

  await loop.runUserTurn({
    sessionId: 'session-trace-archive',
    content: 'Answer a generic high-volume streaming question.',
    requirementConfirmationMode: 'off',
  });

  const responseTrace = transcript.find((entry): entry is TranscriptEntry & { type: 'metadata'; payload: any } =>
    entry.type === 'metadata' &&
    entry.kind === 'provider_trace' &&
    (entry.payload as any)?.stage === 'provider_call.response'
  );
  if (!responseTrace) throw new Error('provider response trace should be archived');
  const payload = (responseTrace.payload as any).payload;
  const archivedJson = JSON.stringify(payload);
  assertEqual(payload.traceArchiveMode, 'compact', 'provider response trace uses compact archive mode');
  assertEqual(payload.response.chunkSummary.chunkCount, chunks.length, 'compact trace records chunk count');
  assertEqual(payload.response.chunkSummary.rawProviderCount, chunks.length, 'compact trace records raw provider count without raw payloads');
  assertEqual(Boolean(payload.response.chunks), false, 'compact trace does not retain raw chunks array');
  assert(archivedJson.length < 120_000, 'compact provider trace stays below transcript body risk threshold');
  assert(!archivedJson.includes('raw-provider-payload-4999'), 'compact trace strips raw provider payload values');
  assert(!archivedJson.includes('generic stream fragment 4999'), 'compact trace strips per-token content values');
}

async function assertProviderPartFramesEnterKernelDraftLedger(): Promise<void> {
  const events: AgentEvent[] = [];
  const deltas: unknown[] = [];
  const draftFrames: Array<Record<string, unknown>> = [];
  const session: AgentSession = {
    id: 'session-draft-frame',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const frame = {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind: 'codeBlockChunk',
    draftId: 'draft-generic',
    frameId: 'frame-generic-1',
    branchId: 'branch-generic',
    subAgentId: 'subagent-generic',
    mergeGroupId: 'merge-generic',
    targetPath: 'src/generated.txt',
    capability: 'fs.write',
    sequence: 1,
    chunk: 'generic draft content\n',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'draftLedgerSubmit') {
        draftFrames.push(command.frame);
        return {
          ok: true,
          events: [
            {
              kind: 'draft.open',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.open' },
            },
            {
              kind: 'draft.chunk',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.chunk', frame: command.frame },
            },
          ],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('provider part frame smoke should use streaming provider path');
    },
    llmChatStream: async (_request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'delta',
        content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>`,
      };
      await onEvent({ type: 'provider_delta', chunk });
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Generic final answer after draft frame.' },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + deltas.length + draftFrames.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-draft-frame',
    content: 'Generate a generic draft through protocol-level streaming frames.',
    requirementConfirmationMode: 'off',
    subAgentMode: 'auto',
  });

  assertEqual(draftFrames.length, 1, 'closed provider part frame is submitted to Kernel draft ledger once');
  assertEqual(draftFrames[0].targetPath, 'src/generated.txt', 'draft frame target path is preserved for Kernel audit');
  assertEqual(draftFrames[0].branchId, 'branch-generic', 'draft frame branch metadata is preserved for Kernel audit');
  assertEqual(draftFrames[0].subAgentId, 'subagent-generic', 'draft frame sub-agent metadata is preserved for Kernel audit');
  assertEqual(deltas.some((delta) => (delta as any).type === 'part_delta'), true, 'Session emits volatile part delta');
  assertEqual(deltas.some((delta) => (delta as any).type === 'part_delta' && (delta as any).branchId === 'branch-generic'), true, 'part delta carries branch metadata');
  assertEqual(deltas.some((delta) => (delta as any).type === 'draft_delta'), true, 'Session emits Kernel draft ledger delta');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'), true, 'final answer still commits through the ordinary parser path');
}

async function assertAcceptedPlanStreamingDraftsAndJsonProgress(): Promise<void> {
  const token = randomSmokeToken('accepted-stream');
  const targetPath = `${token}.txt`;
  const events = [acceptedImplementationPlanCardEvent(`session-${token}`, `run-${token}`)];
  const planPayload = events[0].payload as any;
  planPayload.implementationPlan.tasks[0].target = [targetPath];
  planPayload.implementationPlan.tasks[0].fileOperations = [{
    operation: 'write',
    capability: 'fs.write',
    targetPath,
    reason: 'Random accepted-plan streaming smoke target.',
  }];
  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const deltas: unknown[] = [];
  const draftFrames: unknown[] = [];
  let actionBatchSubmits = 0;
  const proposal = randomMultiWriteProposal([targetPath], { briefUserPlan: true });
  const proposalText = JSON.stringify(proposal);
  const frame = {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind: 'codeBlockChunk',
    frameId: `frame-${token}`,
    draftId: `draft-${token}`,
    blockId: `block-${token}`,
    targetPath,
    chunk: `preview ${token}`,
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'draftLedgerSubmit') {
        draftFrames.push(command.frame);
        return {
          ok: true,
          events: [{
            kind: 'draft.chunk',
            runId: command.runId,
            sessionId: command.sessionId,
            draftId: command.frame?.draftId,
            draft: { draftId: command.frame?.draftId, status: 'draft.chunk' },
            summary: 'Random accepted-plan draft chunk.',
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: `run-${token}`, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: `run-${token}`,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: `run-${token}`, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: `run-${token}`,
              sessionId: session.id,
              workUnitId: `work-unit-${token}`,
              actionId: (command.batch?.actionBundle?.actions?.[0] ?? {}).actionId,
              output: { path: targetPath, actionId: (command.batch?.actionBundle?.actions?.[0] ?? {}).actionId },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('accepted-plan streaming smoke should use llmChatStream');
    },
    llmChatStream: async (_request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      await onEvent({
        type: 'provider_delta',
        chunk: {
          type: 'delta',
          content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>`,
        },
      });
      await onEvent({
        type: 'provider_delta',
        chunk: {
          type: 'delta',
          content: proposalText.slice(0, Math.min(2000, proposalText.length)),
        },
      });
      return jsonLlmResponse(proposal);
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + deltas.length + draftFrames.length + actionBatchSubmits + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: `workspace-${token}`,
      label: `Workspace ${token}`,
      displayPath: `/tmp/${token}`,
      absolutePath: `/tmp/${token}`,
      source: 'projectWorkingDirectory',
      primary: true,
    },
    subAgentMode: 'off',
  });

  assertEqual(draftFrames.length, 1, 'accepted-plan stream part enters Kernel draft ledger once');
  assertEqual(actionBatchSubmits, 1, 'accepted-plan streaming final actionBundle still reaches Kernel');
  assertEqual(
    deltas.some((delta: any) => delta.type === 'part_delta' && delta.targetPath === targetPath),
    true,
    'accepted-plan stream emits visible part_delta before final actionBundle'
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'draft_delta'),
    true,
    'accepted-plan stream emits draft_delta before final actionBundle'
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'stage_delta' && delta.payload?.reason === 'proposal_json_stream_hidden_from_assistant'),
    true,
    'accepted-plan raw JSON delta emits progress instead of a silent wait'
  );
  assertEqual(
    deltas.some((delta: any) => delta.type === 'assistant_delta'),
    false,
    'accepted-plan raw JSON delta is not exposed as a formal assistant answer'
  );
}

function assertNarrativeTimelineProjection(): void {
  const events: AgentEvent[] = [
    {
      id: 'event-user',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze a generic attachment.' },
    },
    {
      id: 'event-thinking',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'reasoning', status: 'running', content: 'Need generic context.' },
    },
    {
      id: 'event-thinking-continued',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.100Z',
      kind: 'assistant_msg',
      payload: { channel: 'reasoning', status: 'running', content: ' Continue with generic constraints.' },
    },
    {
      id: 'event-progress',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.500Z',
      kind: 'assistant_msg',
      payload: { channel: 'progress', source: 'llm', content: 'I will resolve the selected resource before continuing.' },
    },
    {
      id: 'event-progress-session',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.600Z',
      kind: 'assistant_msg',
      payload: { channel: 'progress', source: 'session', content: 'Session-local progress does not become narration.' },
    },
    {
      id: 'event-cache',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.750Z',
      kind: 'cache_telemetry',
      payload: {
        provider: 'deepseek-v4-pro-openai',
        stage: 'plan',
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 20,
        promptTokens: 100,
        completionTokens: 12,
        totalTokens: 112,
      },
    },
    {
      id: 'event-cache-repair',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.850Z',
      kind: 'cache_telemetry',
      payload: {
        provider: 'deepseek-v4-pro-openai',
        stage: 'repair',
        promptCacheHitTokens: 20,
        promptCacheMissTokens: 80,
        promptTokens: 100,
        completionTokens: 8,
        totalTokens: 108,
      },
    },
    {
      id: 'event-tool',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result',
      payload: {
        toolName: 'fs.read',
        summary: 'Read generic resource.',
        evidenceRefs: ['evidence-generic'],
        status: 'completed',
      },
    },
    {
      id: 'event-guidance',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:02.500Z',
      kind: 'user_guidance',
      payload: {
        content: 'Apply this generic guidance at the next provider checkpoint.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'queued',
      },
    },
    {
      id: 'event-plan',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'plan_card',
      payload: { title: 'Generic plan', summary: 'Review generic next step.' },
    },
    {
      id: 'event-answer',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'final', content: 'Generic final answer.' },
    },
  ];

  const projection = buildNarrativeTimelineProjection({
    sessionId: 'session-narrative',
    events,
    generatedAt: '2026-01-01T00:00:05.000Z',
  });
  assertEqual(projection.schemaVersion, 'deepcode.session.timeline.v1', 'narrative timeline is versioned');
  assertEqual(projection.turns.length, 1, 'events are grouped into one turn');
  const kinds = projection.turns[0].blocks.map((block) => block.narrativeKind);
  assertEqual(kinds.includes('user'), true, 'user block is projected');
  assertEqual(kinds.includes('thinking'), true, 'thinking block is projected');
  assertEqual(kinds.includes('assistantNarration'), true, 'llm progress assistant messages become narration');
  assertEqual(kinds.includes('operationEvidence'), true, 'tool facts become operation evidence');
  assertEqual(kinds.includes('requirement'), true, 'user guidance is projected as a user-intervention timeline block');
  assertEqual(kinds.includes('plan'), true, 'plan facts become a plan block');
  assertEqual(kinds.includes('assistantText'), true, 'final answer becomes assistant text');
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'operationEvidence'),
    false,
    'operation evidence stays in the timeline and does not enter task projection'
  );
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'assistantNarration'),
    false,
    'assistant narration does not enter task projection'
  );
  assertEqual(
    projection.taskProjection?.items.length ?? 0,
    0,
    'task projection is empty when no implementation plan tasks exist'
  );
  const processOnlyProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-process-only',
    events: [
      {
        id: 'event-process-user',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'user_msg',
        payload: { content: 'Inspect generic process events.' },
      },
      {
        id: 'event-process-resource',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'workflow_stage',
        payload: { stage: 'resource_resolve', status: 'completed', summary: 'Resolved generic resources.' },
      },
      {
        id: 'event-process-tool',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'tool_result',
        payload: { toolName: 'fs.read', ok: true },
      },
    ],
  });
  assertEqual(
    processOnlyProjection.taskProjection?.items.length ?? 0,
    0,
    'resource, tool, and workflow process events do not create task projection items without plan tasks'
  );
  const activityProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-activity-projection',
    events: [
      {
        id: 'event-activity-user',
        sessionId: 'session-activity-projection',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'user_msg',
        payload: { content: 'Run a generic edit.' },
      },
      {
        id: 'event-activity-workunit',
        sessionId: 'session-activity-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.completed',
          status: 'completed',
          summary: 'A generic target was updated.',
          activity: {
            activityId: 'activity-generic-edit',
            kind: 'editFileCompleted',
            status: 'completed',
            title: 'Generic edit completed',
            summary: 'Kernel completed a generic workspace edit.',
            source: 'kernel',
            runId: 'run-generic-activity',
            targets: ['src/random-alpha.ts'],
            actionIds: ['action-random-alpha'],
            workUnitIds: ['work-unit-random-alpha'],
          },
        },
      },
    ],
  });
  const activityBlock = activityProjection.turns[0].blocks.find((block) => block.activity?.activityId === 'activity-generic-edit');
  assertEqual(activityBlock?.activity?.kind, 'editFileCompleted', 'timeline block carries public conversation activity');
  assertEqual(activityBlock?.title, 'Generic edit completed', 'activity title drives operation block title');
  assertEqual(activityBlock?.status, 'completed', 'activity status drives operation block status');
  const narrationBlock = projection.turns[0].blocks.find((block) => block.narrativeKind === 'assistantNarration');
  assertEqual(narrationBlock?.displayHints?.renderMode, 'typewriter', 'assistant narration uses typewriter projection hints');
  assertEqual(narrationBlock?.displayHints?.checkpointKind, 'llmProposal', 'assistant narration is tied to an LLM proposal checkpoint');
  const thinkingBlock = projection.turns[0].blocks.find((block) => block.narrativeKind === 'thinking');
  assertEqual(
    thinkingBlock?.bodyMarkdown,
    'Need generic context. Continue with generic constraints.',
    'adjacent reasoning events are projected as one complete thinking body'
  );
  assertEqual(Boolean(thinkingBlock?.displayHints?.replaceOnComplete), true, 'thinking exposes replacement/collapse projection hints');
  assertEqual(thinkingBlock?.displayHints?.typewriterSpeed, 'slow', 'running thinking uses a slower typewriter speed');
  const guidanceBlock = projection.turns[0].blocks.find((block) => block.events.some((event) => event.kind === 'user_guidance'));
  assertEqual(guidanceBlock?.title, 'User guidance', 'user guidance has its own visible timeline title');
  assertEqual(guidanceBlock?.status, 'queued', 'user guidance remains queued before provider consumption');
  assertEqual(guidanceBlock?.displayHints?.checkpointKind, 'userGuidance', 'user guidance marks the next provider checkpoint');
  assertEqual(
    projection.turns[0].blocks.some((block) => block.events.some((event) => event.kind === 'cache_telemetry')),
    false,
    'cache telemetry is hidden from narrative blocks'
  );
  assertEqual(projection.tokenUsageProjection?.requests.length, 1, 'cache telemetry is grouped by user request');
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.providerCallCount,
    2,
    'multiple provider calls in one user turn are counted together'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.promptCacheHitTokens,
    100,
    'request cache hit tokens are summed'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.promptCacheMissTokens,
    100,
    'request cache miss tokens are summed'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.cacheHitRate,
    0.5,
    'request cache hit rate uses hit divided by hit plus miss'
  );
  assertEqual(
    projection.tokenUsageProjection?.totals.totalTokens,
    220,
    'token projection totals are summed across provider calls'
  );
  assertEqual(
    projection.turns[0].blocks.some((block) => block.evidenceRefs?.includes('evidence-generic')),
    true,
    'evidence refs are preserved for frontend drilldown'
  );
  assertEqual(
    projection.rawEventRefs?.includes('event:event-tool'),
    true,
    'raw event refs are preserved for debug views'
  );
}

function assertImplementationPlanTaskProjectionProgress(): void {
  const planEvent: AgentEvent = {
    id: 'event-plan-progress',
    sessionId: 'session-task-projection',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId: 'run-task-projection',
      planId: 'plan-task-projection',
      title: 'Generic implementation plan',
      summary: 'Review generic implementation tasks.',
      implementationPlan: {
        id: 'plan-task-projection',
        tasks: [
          {
            taskId: 'task-alpha',
            title: 'Update generic module',
            target: ['src/generic-module.ts'],
            scope: 'Update a generic module.',
            acceptanceCriteria: ['Kernel facts show the module update.'],
            failureCriteria: ['Stop if Kernel rejects the update.'],
          },
          {
            taskId: 'task-beta',
            title: 'Update generic validation',
            target: ['src/generic-validation.ts'],
            scope: 'Update generic validation.',
            acceptanceCriteria: ['Kernel facts show validation update.'],
            failureCriteria: ['Stop if validation cannot be updated.'],
          },
        ],
      },
    },
  };
  const waitingProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [planEvent],
  });
  const waitingItems = waitingProjection.taskProjection?.items ?? [];
  assertEqual(
    waitingItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'waiting'),
    true,
    'implementation plan tasks wait for user confirmation'
  );

  const acceptedNoFactsProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-plan-accepted-no-facts',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
          summary: 'User accepted the generic implementation plan.',
        },
      },
    ],
  });
  const acceptedNoFactsItems = acceptedNoFactsProjection.taskProjection?.items ?? [];
  assertEqual(
    acceptedNoFactsItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'queued'),
    true,
    'accepted implementation tasks stay queued until Kernel WorkUnit or tool facts match them'
  );

  const acceptedProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-plan-accepted',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
          summary: 'User accepted the generic implementation plan.',
        },
      },
      {
        id: 'event-work-alpha',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.completed',
          kernelEvent: {
            kind: 'work_unit.completed',
            output: { path: 'src/generic-module.ts' },
          },
        },
      },
      {
        id: 'event-work-beta',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:03.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.started',
          kernelEvent: {
            kind: 'work_unit.started',
            output: { path: 'src/generic-validation.ts' },
          },
        },
      },
    ],
  });
  const acceptedItems = acceptedProjection.taskProjection?.items ?? [];
  const alpha = acceptedItems.find((item) => item.title === 'Update generic module');
  const beta = acceptedItems.find((item) => item.title === 'Update generic validation');
  assertEqual(alpha?.status, 'completed', 'implementation task status follows matching Kernel completion facts');
  assertEqual(beta?.status, 'running', 'implementation task status follows matching Kernel running facts');
}

function assertSessionDriverSkeleton(): void {
  const driver = new SessionDriver();
  const frame = driver.handleUserTurn({
    sessionId: 'session-generic',
    content: 'Create a generic change.',
    explicitDevelopmentTask: true,
    stateContract: {
      runId: 'run-generic',
      stateId: 'needProposal',
      stateKind: 'driverRequest',
      allowedInputs: ['proposalSubmit'],
      allowedProposals: ['actionBundle'],
      proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
      capabilityProjection: ['fs.write'],
    },
  });
  assertEqual(frame.entryIntent, 'developmentTask', 'SessionDriver routes development work');
  assertEqual(frame.status, 'awaitingKernel', 'SessionDriver skeleton does not execute tools');
}

async function assertSessionDriverLoop(): Promise<void> {
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: 'session-generic',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => fakeLlm(request),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-generic',
    content: 'Analyze the attached resource.',
    attachments: [
      {
        kind: 'file',
        path: 'generic/file.txt',
        absolutePath: '/tmp/generic/file.txt',
        source: 'userSelected',
        scope: 'message',
      },
    ],
  });
  assertEqual(result.events.some((event) => event.kind === 'user_msg'), true, 'DriverLoop appends user turn');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'DriverLoop appends final answer');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'DriverLoop records ResourcePacket context');
}

async function assertSessionDriverLoopTerminalAnswerGuidanceRevision(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-terminal-guidance',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        events.push({
          id: 'guidance-terminal-generic',
          sessionId: 'session-terminal-guidance',
          ts: '2026-01-01T00:00:00.500Z',
          kind: 'user_guidance',
          payload: {
            content: 'Include a generic evaluation dashboard and visible metrics.',
            guidance: 'Include a generic evaluation dashboard and visible metrics.',
            targetRunId: 'run-generic',
            status: 'queued',
            source: 'user',
            effectiveCheckpoint: 'nextProviderCall',
          },
        });
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'Initial generic plan without metrics.' },
        });
      }
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(promptText.includes('Unshown draft answer'), 'guidance revision prompt carries unshown draft answer');
      assert(promptText.includes('Include a generic evaluation dashboard'), 'guidance revision prompt carries queued user guidance');
      events.push({
        id: 'guidance-during-revision-generic',
        sessionId: 'session-terminal-guidance',
        ts: '2026-01-01T00:00:00.750Z',
        kind: 'user_guidance',
        payload: {
          content: 'Keep the final project plan concise.',
          guidance: 'Keep the final project plan concise.',
          targetRunId: 'run-generic',
          status: 'queued',
          source: 'user',
          effectiveCheckpoint: 'nextProviderCall',
        },
      });
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        narration: 'I will merge the new evaluation-dashboard guidance into the current answer.',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Revised generic plan with an evaluation dashboard and visible metrics.' },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-terminal-guidance',
    content: 'Plan a generic learning project.',
  });

  const finalMessages = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
  assertEqual(llmCalls, 2, 'terminal queued guidance triggers one guidance revision provider call');
  assertEqual(finalMessages.length, 1, 'draft answer is replaced by a single final answer');
  assert(String((finalMessages[0]?.payload as any)?.content ?? '').includes('evaluation dashboard'), 'final answer applies queued guidance');
  assertEqual(Boolean((finalMessages[0]?.payload as any)?.guidanceRevision), true, 'final answer records guidance revision metadata');
  assertEqual(
    Array.isArray((finalMessages[0]?.payload as any)?.appliedGuidanceIds) &&
      (finalMessages[0]?.payload as any).appliedGuidanceIds.includes('guidance-terminal-generic'),
    true,
    'final answer records applied guidance ids'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'session' &&
      String((event.payload as any)?.content ?? '').includes('received your update')
    ),
    true,
    'session transition message follows the user language before guidance revision'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'llm' &&
      String((event.payload as any)?.content ?? '').includes('evaluation-dashboard')
    ),
    true,
    'LLM narration transition is visible when returned'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'user_guidance' &&
      (event.payload as any)?.status === 'consumed' &&
      (event.payload as any)?.guidanceId === 'guidance-terminal-generic' &&
      (event.payload as any)?.appliedAtProviderStage === 'guidance_revision'
    ),
    true,
    'consumed guidance records guidance revision provider checkpoint'
  );
  const remainingGuidance = collectUserGuidanceEvents(result.events, 'run-generic');
  assertEqual(
    remainingGuidance.some((item) => item.id === 'guidance-during-revision-generic'),
    true,
    'guidance arriving during guidance revision remains queued for a later checkpoint'
  );
}

async function assertSessionDriverLoopTerminalGuidanceRevisionFallback(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-terminal-guidance-fallback',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        events.push({
          id: 'guidance-terminal-fallback-generic',
          sessionId: 'session-terminal-guidance-fallback',
          ts: '2026-01-01T00:00:00.500Z',
          kind: 'user_guidance',
          payload: {
            content: 'Add a generic evaluation view.',
            guidance: 'Add a generic evaluation view.',
            targetRunId: 'run-generic',
            status: 'queued',
            source: 'user',
            effectiveCheckpoint: 'nextProviderCall',
          },
        });
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'Initial fallback answer.' },
        });
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-terminal-guidance-fallback',
    content: 'Plan another generic learning project.',
  });

  const finalMessages = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
  assertEqual(llmCalls, 2, 'terminal guidance fallback attempts one revision call');
  assertEqual(finalMessages.length, 1, 'fallback path still produces one final answer');
  assertEqual(String((finalMessages[0]?.payload as any)?.content ?? ''), 'Initial fallback answer.', 'fallback final answer uses initial draft');
  assertEqual(Boolean((finalMessages[0]?.payload as any)?.guidanceRevisionFailed), true, 'fallback final answer records guidance revision failure');
  assertEqual(result.events.some((event) => event.kind === 'error'), true, 'guidance revision failure records a diagnostic event');
}

async function assertSessionDriverLoopPathResourceRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-path',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-path',
            packet: {
              id: `packet-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: entry.kind === 'directory' ? 'directoryTree' : 'fileText',
                absolutePath: entry.resourceRef,
                nodes: entry.kind === 'directory' ? [{ type: 'file', path: 'README.txt' }] : undefined,
                content: entry.kind === 'directory' ? undefined : 'generic resolved file content',
                evidenceRefs: ['evidence-path'],
              }],
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: 'deepcode.agent.protocol.v3',
                kind: 'resourceRequest',
                outputLanguage: 'en-US',
                resourceRequest: {
                  version: '1',
                  id: 'need-generic-file',
                  reason: 'Need a generic file from the attached directory.',
                  items: [{ id: 'generic-source', path: 'src/main.txt', reason: 'Read generic project source.' }],
                },
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Generic directory context was resolved by path.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-path',
    content: 'Analyze the attached directory.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'path resourceRequest reaches final answer');
  assert(resourceResolveManifests.length >= 2, 'path resourceRequest triggers a second Kernel ResourceResolve');
  const secondEntry = resourceResolveManifests[1].entries[0];
  assertEqual(secondEntry.kind, 'resource', 'path resourceRequest is synthesized as a Kernel-resolved resource');
  assertEqual(secondEntry.resourceRef, '/tmp/generic-project/src/main.txt', 'path resourceRequest stays under the attached directory');
}

async function assertSessionDriverLoopSearchResourceRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-search-resource',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const manifest = command.request?.manifest as any;
        resourceResolveManifests.push(manifest);
        const entry = manifest?.entries?.[0] ?? {};
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            packet: {
              id: `packet-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'search-item',
                manifestEntryId: entry.id ?? 'search-entry',
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                resolvedKind: entry.kind,
                contentKind: entry.kind === 'search' ? 'searchResults' : 'directoryTree',
                path: entry.path ?? entry.resourceRef,
                absolutePath: entry.resourceRef,
                query: entry.query,
                include: entry.include,
                matches: entry.kind === 'search'
                  ? [{ path: 'src/generic.txt', line: 2, preview: 'generic anchor line' }]
                  : undefined,
                returnedMatches: entry.kind === 'search' ? 1 : undefined,
                truncated: false,
                promptContent: entry.kind === 'search'
                  ? JSON.stringify({ matches: [{ path: 'src/generic.txt', line: 2, preview: 'generic anchor line' }] })
                  : undefined,
                nodes: entry.kind === 'search' ? undefined : [{ type: 'file', path: 'src/generic.txt' }],
                evidenceRefs: ['evidence-search'],
              }],
            },
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'resourceRequest',
          outputLanguage: 'en-US',
          resourceRequest: {
            version: '1',
            id: 'need-generic-search',
            reason: 'Need generic search evidence.',
            items: [{
              id: 'search-anchor',
              kind: 'search',
              query: 'generic anchor',
              include: ['src/'],
              contextLines: 2,
              maxResults: 10,
              reason: 'Find a generic anchor.',
            }],
          },
        });
      }
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Generic search evidence was resolved.' },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-search-resource',
    content: 'Find a generic anchor before editing.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'search resourceRequest reaches final answer');
  assert(resourceResolveManifests.length >= 2, 'search resourceRequest triggers Kernel ResourceResolve');
  const secondEntry = resourceResolveManifests[1].entries[0];
  assertEqual(secondEntry.kind, 'search', 'search resourceRequest is synthesized as a Kernel search entry');
  assertEqual(secondEntry.query, 'generic anchor', 'search manifest carries query');
  assertEqual(secondEntry.include[0], 'src/', 'search manifest carries include filter');
  assertEqual(secondEntry.contextLines, 2, 'search manifest carries contextLines');
  assertEqual(secondEntry.maxResults, 10, 'search manifest carries maxResults');
}

async function assertSessionDriverLoopRejectsOutsidePath(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-outside',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-outside',
            packet: {
              id: `packet-outside-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: 'directoryTree',
                absolutePath: entry.resourceRef,
                nodes: [],
                evidenceRefs: ['evidence-outside'],
              }],
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: 'deepcode.agent.protocol.v3',
                kind: 'resourceRequest',
                outputLanguage: 'en-US',
                resourceRequest: {
                  version: '1',
                  id: 'outside-request',
                  reason: 'Attempt to read an outside path.',
                  items: [{ id: 'outside-item', path: '/tmp/outside.txt', reason: 'Outside path should not be granted.' }],
                },
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Outside path was not granted.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-outside',
    content: 'Analyze the attached directory.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'outside path repair reaches final answer');
  assertEqual(resourceResolveManifests.length, 1, 'outside absolute path does not become a Kernel ResourceResolve manifest entry');
}

async function assertSessionDriverLoopUsesRecentAttachmentRoot(): Promise<void> {
  const events: AgentEvent[] = [];
  const existingEvents: AgentEvent[] = [{
    id: 'previous-user',
    sessionId: 'session-recent',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: {
      content: 'Analyze the attached directory.',
      attachments: [{
        kind: 'directory',
        path: 'previous-generic-project',
        absolutePath: '/tmp/previous-generic-project',
        source: 'userSelected',
        scope: 'message',
      }],
    },
  }];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-recent',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-recent',
            packet: {
              id: `packet-recent-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: 'fileText',
                absolutePath: entry.resourceRef,
                content: 'recent generic content',
                evidenceRefs: ['evidence-recent'],
              }],
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: 'deepcode.agent.protocol.v3',
                kind: 'resourceRequest',
                outputLanguage: 'en-US',
                resourceRequest: {
                  version: '1',
                  id: 'recent-path-request',
                  reason: 'Need a file from the recent attached directory.',
                  items: [{ id: 'recent-file', path: 'README.txt', reason: 'Read generic overview.' }],
                },
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Recent attachment root was reused.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-recent',
    content: 'Read the overview from that project.',
    attachments: [],
    existingEvents,
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'recent root path request reaches final answer');
  assertEqual(resourceResolveManifests.length, 1, 'recent attachment root is not auto-read before the model requests a path');
  assertEqual(resourceResolveManifests[0].entries[0].resourceRef, '/tmp/previous-generic-project/README.txt', 'recent root resolves path under the previous attachment');
}

async function assertSessionDriverLoopReadOnlyRequestsContinueWithoutBudgetDecision(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-readonly-unbounded',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-readonly-unbounded'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(!promptText.includes('Read-only resource budget:'), 'provider prompt does not expose fixed read-only resource budget');
      if (llmCalls > 12) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'Read-only exploration continued and then converged.' },
        });
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'resourceRequest',
              outputLanguage: 'en-US',
              resourceRequest: {
                version: '1',
                id: `budget-request-${llmCalls}`,
                reason: 'Need another generic resource.',
                items: [{ id: `budget-item-${llmCalls}`, path: `src/file-${llmCalls}.txt`, reason: 'Read the next generic source.' }],
              },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-readonly-unbounded',
    content: 'Analyze the attached generic project.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(llmCalls, 13, 'read-only resource requests continue beyond the former eight-round budget and then converge');
  assertEqual(resourceResolveManifests.length, 13, 'initial attachment plus twelve requested resource packets were resolved');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'read-only resource loop no longer emits a budget decision card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.diagnostic === true), false, 'read-only continuation is not a terminal diagnostic');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.channel === 'final' &&
      String((event.payload as any)?.content ?? '').includes('continued')
    ),
    true,
    'read-only continuation produces a final answer when the provider converges'
  );
}

async function assertSessionDriverLoopOldResourceBudgetDecisionStillResumes(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-budget-legacy',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const oldBudgetConfirmation: AgentEvent = {
    id: 'legacy-resource-budget-confirmation',
    sessionId: 'session-budget-legacy',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: '用户介入请求',
      summary: '只读资源预算已用完，需要用户决定是否继续读取上下文。',
      status: 'waitingUserConfirmation',
      confirmable: true,
      runId: 'run-budget-legacy',
      requirementId: 'resource-budget-run-budget-legacy',
      originalUserRequest: 'Analyze the attached generic project.',
      attachments: [],
      requirement: {
        requirementId: 'resource-budget-run-budget-legacy',
        sessionId: 'session-budget-legacy',
        initialUserRequest: 'Analyze the attached generic project.',
        checklist: { goal: 'Legacy budget confirmation.' },
        status: 'probing',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-budget-legacy'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(!promptText.includes('Read-only resource budget:'), 'legacy budget continuation resumes without exposing a new fixed budget');
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Continued after legacy budget approval.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const next = await loop.resolveDecision({
    sessionId: 'session-budget-legacy',
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-budget-legacy',
    targetId: 'resource-budget-run-budget-legacy',
    existingEvents: [oldBudgetConfirmation],
  });
  assertEqual(llmCalls, 1, 'legacy budget approval resumes by calling the provider once');
  assertEqual(next.events.some((event) => event.kind === 'trace/requirement_decision_noop'), false, 'legacy budget confirmation is still recognized as active');
  assertEqual(next.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'), true, 'legacy budget approval continues to final answer');
}

function resourceBudgetKernel(
  request: KernelCommandEnvelope,
  resourceResolveManifests: Array<Record<string, any>>,
  sessionId: string
): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') {
    const reply = fakeKernel(request);
    for (const event of reply.events ?? []) {
      (event as any).sessionId = sessionId;
    }
    return reply;
  }
  if (command.kind === 'resourceResolve') {
    resourceResolveManifests.push(command.request.manifest);
    const entry = command.request.manifest.entries[0];
    return {
      ok: true,
      events: [{
        kind: 'resource.packet_produced',
        runId: 'run-generic',
        sessionId,
        packet: {
          id: `packet-budget-${resourceResolveManifests.length}`,
          requestId: command.requestId,
          items: [{
            requestItemId: 'item-generic',
            manifestEntryId: entry.id,
            status: 'resolved',
            readPolicy: 'explicit-manifest-readonly',
            sourceKind: entry.kind,
            contentKind: entry.kind === 'directory' ? 'directoryTree' : 'fileText',
            absolutePath: entry.resourceRef,
            path: entry.resourceRef,
            nodes: entry.kind === 'directory' ? [{ type: 'file', path: 'src/file-1.txt' }] : undefined,
            content: entry.kind === 'directory' ? undefined : `content for ${String(entry.resourceRef).replace('/tmp/generic-project/', '')}`,
            truncated: entry.kind !== 'directory' && String(entry.resourceRef).endsWith('file-8.txt'),
            originalBytes: entry.kind !== 'directory' ? 24000 : undefined,
            evidenceRefs: ['evidence-budget'],
          }],
        },
      }],
    };
  }
  return { ok: true, events: [] };
}

async function assertSessionDriverLoopRepairsSideEffectBundleEvidence(): Promise<void> {
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-plan-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    appendTranscript: async (_sessionId, entry) => {
      transcript.push(entry);
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'proposalSubmit') {
        submittedPlans.push(command.proposal);
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            {
              kind: 'proposal.accepted',
              runId: 'run-generic',
              sessionId: 'session-plan-repair',
              proposal: command.proposal,
            },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: 'session-plan-repair',
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const bundle = genericWriteProposal(llmCalls === 1);
      return {
        ok: true,
        data: {
          chunks: [{ type: 'reasoning_delta', content: `generic reasoning ${llmCalls}` }, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            reasoningContent: `generic reasoning ${llmCalls}`,
            content: JSON.stringify(bundle),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + transcript.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-plan-repair',
    content: 'Create a generic scaffold.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'side-effect actionBundle missing evidence triggers one protocol repair');
  assertEqual(submittedPlans.length, 1, 'repaired actionBundle reaches Kernel ProposalSubmit once');
  assertEqual(submittedPlans[0].kind, 'actionBundle', 'repaired proposal remains an actionBundle');
  const repairedBundle = submittedPlans[0].payload?.actionBundle ?? {};
  assertEqual((repairedBundle.validationExpectations ?? []).length, 1, 'repaired actionBundle contains validation expectations');
  assertEqual((repairedBundle.reviewExpectations ?? []).length, 1, 'repaired actionBundle contains review expectations');
  const planCards = result.events.filter((event) => event.kind === 'plan_card');
  const planReviews = result.events.filter((event) => event.kind === 'plan_review');
  assertEqual(planCards.length, 1, 'repaired plan renders one interactive plan card');
  assertEqual((planCards[0]?.payload as any)?.decisionOwner?.kind, 'plan', 'plan card owns the plan decision');
  assertEqual((planCards[0]?.payload as any)?.status, 'awaitingUserApproval', 'plan card carries Kernel review status');
  assertEqual(planReviews.length, 1, 'Kernel plan review remains recorded for audit');
  assertEqual((planReviews[0]?.payload as any)?.confirmable, false, 'Kernel plan review is not a second decision owner');
  assertEqual((planReviews[0]?.payload as any)?.visibility, 'debug', 'Kernel plan review is debug/audit only');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'plan_review'
    ),
    true,
    'waiting plan review is exposed as an explicit session run state'
  );
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'reasoning'), true, 'provider reasoning is visible');
  assertEqual(transcript.some((entry) => entry.type === 'metadata' && entry.kind === 'provider_trace'), true, 'provider trace is archived');
}

async function assertSessionDriverLoopRepairsInvalidSourceBlock(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-source-block-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-repair', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const proposal = genericWriteProposal(false);
      if (llmCalls === 1) {
        (proposal.actionBundle as any).actions[0].sourceBlockId = 'missing-code-block';
      }
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-repair',
    content: 'Create a generic scaffold.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'invalid sourceBlockId triggers one protocol repair');
  assertEqual(submittedPlans.length, 1, 'only repaired actionBundle reaches Kernel');
  assertEqual(
    submittedPlans[0].payload?.actionBundle?.actions?.[0]?.sourceBlockId,
    'generic-block',
    'repaired actionBundle sourceBlockId matches a code block'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired sourceBlockId plan renders a plan card');
}

async function assertSessionDriverLoopCanonicalizesMissingSourceBlockId(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-source-block-canonicalize',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-canonicalize', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const proposal = genericWriteProposal(false);
      delete (proposal.actionBundle as any).actions[0].args.sourceBlockId;
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-canonicalize',
    content: 'Create a generic file from the provided code block.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'missing sourceBlockId with a unique targetPath match is canonicalized without provider repair');
  assertEqual(submittedPlans.length, 1, 'canonicalized actionBundle reaches Kernel PlanReview once');
  const action = submittedPlans[0].payload?.actionBundle?.actions?.[0] ?? {};
  assertEqual(action.sourceBlockId, 'generic-block', 'canonicalized action exposes sourceBlockId for existing Session checks');
  assertEqual(action.args?.sourceBlockId, 'generic-block', 'canonicalized action writes args.sourceBlockId for Kernel execution');
  assertEqual(
    submittedPlans[0].parserDiagnostics?.canonicalizations?.[0]?.kind,
    'fs_write_sourceBlockId_canonicalized',
    'canonicalization telemetry records the safe sourceBlockId repair'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'canonicalized write renders a plan card');
}

async function assertSessionDriverLoopRepairsAmbiguousSourceBlockId(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-source-block-ambiguous',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-ambiguous', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      if (llmCalls === 1) {
        const proposal = genericWriteProposal(false);
        proposal.codeBlocks = [
          { blockId: 'generic-block-a', targetPath: 'generic-output.txt', contentLines: ['generic content a'] },
          { blockId: 'generic-block-b', targetPath: 'generic-output.txt', contentLines: ['generic content b'] },
        ];
        delete (proposal.actionBundle as any).actions[0].args.sourceBlockId;
        return jsonLlmResponse(proposal);
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-ambiguous',
    content: 'Create a generic file from one of several candidate blocks.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'ambiguous missing sourceBlockId triggers one protocol repair');
  assertEqual(repairRequests.length, 1, 'ambiguous sourceBlockId repair asks provider once');
  assert(
    repairRequests[0].messages.some((message) => message.content.includes('args.sourceBlockId')),
    'repair prompt explains the fs.write args.sourceBlockId requirement'
  );
  assertEqual(submittedPlans.length, 1, 'only repaired ambiguous sourceBlockId proposal reaches Kernel');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired ambiguous write renders a plan card');
}

async function assertSessionDriverLoopRepairsEmptyDirectoryPlaceholderWrite(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-empty-placeholder-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-empty-placeholder-repair', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      if (llmCalls === 1) {
        const proposal = genericWriteProposal(false);
        proposal.codeBlocks = [{
          blockId: 'generic-placeholder-block',
          targetPath: 'generic-dir/.gitkeep',
          operation: 'create',
          allowEmptyContent: true,
          contentLines: [],
        }];
        (proposal.actionBundle as any).actions[0].args = {
          path: 'generic-dir/.gitkeep',
          sourceBlockId: 'generic-placeholder-block',
        };
        return jsonLlmResponse(proposal);
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-empty-placeholder-repair',
    content: 'Create concrete files under a generic directory.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'empty placeholder write triggers one protocol repair');
  assert(
    repairRequests[0].messages.some((message) => message.content.includes('.gitkeep') && message.content.includes('Directory targets')),
    'repair prompt rejects empty directory placeholder writes'
  );
  assertEqual(submittedPlans.length, 1, 'repaired placeholder write reaches Kernel');
  assertEqual(
    submittedPlans[0].payload?.actionBundle?.actions?.[0]?.args?.path,
    'generic-output.txt',
    'repair replaces placeholder directory write with a concrete file write'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired placeholder write renders a plan card');
}

async function assertSessionDriverLoopAllowsManyNoCodeActionsWithoutBatchRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-many-delete-actions',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-many-delete-actions', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      return jsonLlmResponse(manyDeleteActionsProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-many-delete-actions',
    content: 'Delete several generic obsolete files in one reviewed batch.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'many no-code actions do not trigger implementation batch repair');
  assertEqual(repairRequests.length, 0, 'many no-code actions do not ask the provider to shrink by action count');
  assertEqual(submittedPlans.length, 1, 'many delete actions reach Kernel PlanReview once');
  assertEqual(submittedPlans[0].payload?.actionBundle?.actions?.length, 7, 'all delete actions remain in the Kernel-reviewed proposal');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'many delete action plan renders a Kernel-reviewed plan card');
}

async function assertSessionDriverLoopAllowsManyCodeBlocksWithoutBatchRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-many-codeblocks',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-many-codeblocks', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      return jsonLlmResponse(manyCodeBlockWriteProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-many-codeblocks',
    content: 'Create several generic files in one reviewed batch.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 1, 'many codeBlocks under payload budget do not trigger repair');
  assertEqual(repairRequests.length, 0, 'many codeBlocks do not ask the provider to shrink by count');
  assertEqual(submittedPlans.length, 1, 'many codeBlocks reach Kernel PlanReview once');
  assertEqual(submittedPlans[0].payload?.codeBlocks?.length, 7, 'all codeBlocks remain in the Kernel-reviewed proposal');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'many codeBlock plan renders a plan card');
}

async function assertSessionDriverLoopRepairsOversizedActionBundle(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-budget-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-budget-repair', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      const bundle = llmCalls === 1 ? oversizedGenericWriteProposal() : genericWriteProposal(false);
      return jsonLlmResponse(bundle);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-budget-repair',
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'oversized actionBundle triggers one implementation batch repair');
  assert(repairRequests.some((request) => request.messages.some((message) => message.content.includes('module, file section, class, function'))), 'repair prompt requests semantic payload splitting');
  assertEqual(submittedPlans.length, 1, 'repaired oversized actionBundle reaches Kernel plan review once');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired oversized plan renders a plan card');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  assertEqual(Boolean((planCard?.payload as any)?.implementationBatch), true, 'plan card carries implementation batch context');
}

async function assertSessionDriverLoopRepairsEmptyActionBundleResponse(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-empty-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-empty-repair', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'reasoning_delta', content: 'generic large draft reasoning' }, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              reasoningContent: 'generic large draft reasoning',
              content: '',
            },
          },
        };
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-empty-repair',
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'empty actionBundle response triggers one compact repair');
  assertEqual(submittedPlans.length, 1, 'repaired empty response reaches Kernel plan review once');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired empty response renders a plan card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && String((event.payload as any).content ?? '').includes('没有返回有效 JSON')), true, 'empty response repair is visible as Thinking');
}

async function assertSessionDriverLoopAcceptsLocalizedStructuredPlan(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-localized-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-localized-plan', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(localizedGenericWriteProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-localized-plan',
    content: 'Create a generic workspace change.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(submittedPlans.length, 1, 'localized structured plan reaches Kernel without heading repair');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'localized structured plan renders a plan card');
}

async function assertSessionDriverLoopPlanRevisionReturnsToPlanning(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-plan-revision', 'run-plan-revision')];
  const session: AgentSession = {
    id: 'session-plan-revision',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const llmRequests: LlmChatRequest[] = [];
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericTaskPlanProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmRequests.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'revise',
    guidance: 'Adjust the generic plan to stay as a reply-only planning exercise.',
    runId: 'run-plan-revision',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(
    result.events.some((event) =>
      event.kind === 'plan_review' &&
      (event.payload as any)?.status === 'needsRevision' &&
      (event.payload as any)?.planId === 'impl-generic-auto'
    ),
    true,
    'plan revise records a needsRevision decision for the pending plan'
  );
  assertEqual(
    result.events.filter((event) => event.kind === 'plan_card').length >= 2,
    true,
    'plan revise starts a new planning turn with a new plan card'
  );
  assertEqual(llmRequests.length, 1, 'plan revise calls provider once for replanning');
  assertEqual(actionBatchSubmits, 0, 'plan revise does not execute the old plan');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('reply-only planning exercise'), 'plan revision guidance enters the next PromptEnvelope');
  assert(promptText.includes('Do not execute work'), 'plan revision prompt keeps the revised plan non-executable');
}

function assertWorkflowStagePermissionProjectsPendingDecision(): void {
  const pending = findLatestPendingPermission([
    {
      id: 'event-permission',
      sessionId: 'session-permission',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'workflow_stage',
      payload: {
        kernelEvent: {
          kind: 'permission.requested',
          runId: 'run-permission',
          planId: 'plan-permission',
          request: {
            id: 'permission-generic',
            capability: 'fs.write',
            riskLevel: 'medium',
            summary: 'Allow a generic write operation?',
            argsPreview: { path: 'generic-output.txt' },
          },
        },
      },
    },
  ]);
  assertEqual(pending?.request.id, 'permission-generic', 'workflow_stage permission.requested is recognized as pending permission');
}

async function assertSessionDriverLoopReviewRevisionReturnsToPlanning(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-generic',
    sessionId: 'session-review-revision',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-source',
      reviewId: 'review-generic',
      sourcePlanId: 'plan-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: [
        '- `fs.write` ok: {"path":"generic-output.txt","validation":{"kind":"readBack","passed":true}}',
        '- `work-unit-generic` completed: {"path":"generic-output.txt"}',
      ],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'fs.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-revision',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-revision', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-revision',
    kind: 'review',
    decision: 'revise',
    guidance: 'Add a generic script and document how to run it.',
    runId: 'run-review-source',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'needsRevision'), true, 'review guidance is recorded as needsRevision');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'review revision starts a new planning turn');
  assertEqual(submittedPlans.length, 1, 'review revision submits the new actionBundle to Kernel PlanReview');
  assertEqual(llmRequests.length, 1, 'review revision calls the provider for a new plan once');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('Add a generic script and document how to run it.'), 'review guidance enters the next PromptEnvelope');
  assert(promptText.includes('ProjectMemoryIndexDigest'), 'structured project memory index digest is included');
  assert(promptText.includes('ProjectMemoryRecall'), 'dynamic project memory recall is included');
  assert(promptText.includes('SessionMemoryCompact'), 'structured session memory compact summary is included');
  assert(!promptText.includes('content=Review fact'), 'raw review facts are not promoted into ProjectMemory prompt content');
}

async function assertSessionDriverLoopReviewRevisionContinuesWhenAuditRunInactive(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-inactive-audit',
    sessionId: 'session-review-revision-inactive-audit',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-inactive-audit',
      reviewId: 'review-inactive-audit',
      sourcePlanId: 'plan-inactive-audit',
      content: '## Review\n\nA generic completed batch needs a revision.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-revision-inactive-audit',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  let userDecisionSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return {
          ok: false,
          events: [],
          error: {
            code: 'run_not_active',
            message: 'invalid command: run is not active',
          },
        };
      }
      return planKernel(request, session.id, submittedPlans);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + userDecisionSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'review',
    decision: 'revise',
    guidance: 'Revise the generic batch with an additional safe detail.',
    runId: 'run-review-inactive-audit',
    existingEvents: events,
  });

  assertEqual(userDecisionSubmits, 1, 'review revise still attempts one Kernel audit decision');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'trace/review_accept_noop' &&
      (event.payload as any)?.errorCode === 'run_not_active'
    ),
    true,
    'inactive review audit is recorded as a Session trace'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'review revise continues to a new planning turn after audit failure');
  assertEqual(submittedPlans.length, 1, 'review revise still submits the repaired plan to Kernel PlanReview');
  assertEqual(llmRequests.length, 1, 'review revise calls provider once after best-effort audit failure');
}

async function assertSessionDriverLoopAcceptedDecisionGroupsWorkspaceWriteGrants(): Promise<void> {
  const actionBundle = multiWriteActionBundle();
  const events: AgentEvent[] = [
    {
      id: 'plan-card-multi-write',
      sessionId: 'session-plan-grant-group',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-grant-group',
        planId: 'bundle-multi-write',
        proposalId: 'proposal-multi-write',
        content: '# Plan\n\n## Summary\nWrite multiple generic files.',
        actionBundle,
        codeBlocks: [
          { id: 'code-one', blockId: 'code-one', targetPath: 'generic-one.txt', content: 'one', contentLines: ['one'] },
          { id: 'code-two', blockId: 'code-two', targetPath: 'generic-two.txt', content: 'two', contentLines: ['two'] },
        ],
        commandBlocks: [],
        planReviewReport: proposalReviewReport(actionBundle),
      },
    },
    {
      id: 'plan-review-multi-write',
      sessionId: 'session-plan-grant-group',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingTemporaryGrant',
        runId: 'run-plan-grant-group',
        planId: 'bundle-multi-write',
        confirmable: true,
        report: proposalReviewReport(actionBundle),
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-grant-group',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const temporaryGrants: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants.push(command.grant);
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + temporaryGrants.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: 'session-plan-grant-group',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-grant-group',
    targetId: 'bundle-multi-write',
    existingEvents: events,
  });

  assertEqual(temporaryGrants.length, 2, 'multiple fs.write actions receive file-scoped temporary grants');
  assertEqual(
    temporaryGrants.map((grant) => grant.resourcePath).sort().join(','),
    'generic-one.txt,generic-two.txt',
    'temporary grants are scoped to Kernel-reviewed file operations'
  );
  assertEqual(temporaryGrants.every((grant) => grant.capability === 'fs.write'), true, 'all grants keep the reviewed capability');
  assertEqual(
    temporaryGrants.every((grant) => (grant.permissionBundle as any)?.groupedBy === 'fileOperation'),
    true,
    'temporary grants record file operation grouping metadata'
  );
}

async function assertSessionDriverLoopAcceptedDecisionGrantsOutsideWorkspaceFileTargets(): Promise<void> {
  const externalTarget = `/tmp/deepcode-external-${Date.now()}-target.txt`;
  const actionBundle: Record<string, any> = {
    version: '1',
    id: 'bundle-external-write',
    goal: 'Write a reviewed outside-workspace file.',
    actions: [
      {
        id: 'write-external',
        title: 'Write external file',
        kind: 'write',
        capability: 'fs.write',
        targetPath: externalTarget,
        resourceScope: [externalTarget],
        sourceBlockId: 'code-external',
        permissionLabels: ['fs.write'],
      },
    ],
    validationExpectations: [{ id: 'validation', description: 'Kernel records the reviewed outside file write.' }],
    reviewExpectations: [{ id: 'review', description: 'User reviews the outside file operation.' }],
  };
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-external-write',
      sessionId: 'session-plan-grant-external',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-grant-external',
        planId: 'bundle-external-write',
        proposalId: 'proposal-external-write',
        content: '# Plan\n\n## Summary\nWrite one outside-workspace file after Kernel review.',
        actionBundle,
        codeBlocks: [
          { id: 'code-external', targetPath: externalTarget, content: 'outside' },
        ],
        commandBlocks: [],
        planReviewReport: report,
      },
    },
    {
      id: 'plan-review-external-write',
      sessionId: 'session-plan-grant-external',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingTemporaryGrant',
        runId: 'run-plan-grant-external',
        planId: 'bundle-external-write',
        confirmable: true,
        report,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-grant-external',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const temporaryGrants: Array<Record<string, any>> = [];
  const submittedBatches: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants.push(command.grant);
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        submittedBatches.push(command.batch);
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + temporaryGrants.length + submittedBatches.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: 'session-plan-grant-external',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-grant-external',
    targetId: 'bundle-external-write',
    existingEvents: events,
  });

  assertEqual(temporaryGrants.length, 1, 'outside-workspace file operation receives one scoped temporary grant');
  assertEqual(temporaryGrants[0]?.resourceKind, 'externalFile', 'outside-workspace grant uses externalFile resource kind');
  assertEqual(temporaryGrants[0]?.resourcePath, externalTarget, 'outside-workspace grant preserves absolute file target');
  assertEqual(submittedBatches.length, 1, 'reviewed outside-workspace batch is submitted after grant');
  const submittedAction = submittedBatches[0]?.actionBundle?.actions?.[0];
  assertEqual(submittedAction?.targetPath, externalTarget, 'submitted action preserves absolute file target for Kernel resolver');
}

async function assertSessionDriverLoopPlanCardAcceptDoesNotNoopWithoutPlanReview(): Promise<void> {
  const actionBundle = genericActionBundle();
  const events: AgentEvent[] = [
    {
      id: 'plan-card-only-generic',
      sessionId: 'session-plan-card-only',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-card-only',
        planId: 'bundle-generic',
        proposalId: 'proposal-plan-card-only',
        title: 'Generic reviewed plan',
        summary: 'Review a generic workspace plan.',
        content: '# Plan\n\n## Summary\nReview a generic workspace plan.',
        actionBundle,
        codeBlocks: [{ id: 'code-generic', targetPath: 'generic/output.txt', content: 'generic output' }],
        commandBlocks: [],
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-card-only',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let userDecisionSubmits = 0;
  let actionBatchSubmits = 0;
  let temporaryGrants = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-plan-card-only',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-card-only',
    targetId: 'bundle-generic',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'trace/plan_accept_noop'), false, 'plan_card-only accept does not become a stale noop');
  assertEqual(result.events.some((event) => event.kind === 'plan_review' && (event.payload as any).status === 'accepted'), true, 'plan_card-only accept records one accepted plan review');
  assertEqual(userDecisionSubmits, 1, 'plan_card-only accept submits one user decision to Kernel');
  assertEqual(temporaryGrants, 0, 'plan_card-only accept without Kernel file operation review does not receive broad workspace grant');
  assertEqual(actionBatchSubmits, 1, 'plan_card-only accept submits the accepted action batch');
}

async function assertSessionDriverLoopPlanCardAcceptExecutesReviewedDeletePlan(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-obsolete.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-reviewed-delete',
      sessionId: 'session-reviewed-delete-plan',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-reviewed-delete-plan',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-reviewed-delete',
        title: 'Generic delete plan',
        summary: 'Delete one generic reviewed file.',
        content: '# Plan\n\n## Summary\nDelete one generic reviewed file.',
        actionBundle,
        codeBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingTemporaryGrant',
        planReviewReport: report,
        requiredFileOperations: report.requiredFileOperations,
      },
    },
    {
      id: 'plan-review-reviewed-delete',
      sessionId: 'session-reviewed-delete-plan',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingTemporaryGrant',
        runId: 'run-reviewed-delete-plan',
        planId: 'bundle-generic-delete',
        confirmable: true,
        report,
        requiredFileOperations: report.requiredFileOperations,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-reviewed-delete-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const temporaryGrants: Array<Record<string, any>> = [];
  let userDecisionSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants.push(command.grant);
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-reviewed-delete',
              output: { path: 'generic-obsolete.txt' },
            },
            { kind: 'stage.changed', runId: command.runId, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + actionBatchSubmits + temporaryGrants.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-reviewed-delete-plan',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(userDecisionSubmits, 1, 'reviewed fs.delete plan submits user decision to Kernel');
  assertEqual(temporaryGrants.length, 1, 'reviewed fs.delete plan receives one path-scoped grant');
  assertEqual(temporaryGrants[0]?.capability, 'fs.delete', 'reviewed delete grant keeps fs.delete capability');
  assertEqual(temporaryGrants[0]?.resourcePath, 'generic-obsolete.txt', 'reviewed delete grant is scoped to the reviewed file');
  assertEqual(actionBatchSubmits, 1, 'reviewed fs.delete plan submits accepted action batch');
  assertEqual(
    result.events.some((event) => event.kind === 'workflow_stage' && (event.payload as any)?.stage === 'accepted_plan.action_batch_preflight'),
    true,
    'reviewed fs.delete plan emits accepted-plan preflight before Kernel submit'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    false,
    'reviewed fs.delete plan does not fail before actionBatchSubmit'
  );
}

async function assertSessionDriverLoopAcceptedPlanExecutesReviewedDeleteWithoutTaskTargets(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-obsolete.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const planCard = deleteAcceptedImplementationPlanCardEvent('session-reviewed-delete-no-targets', 'run-reviewed-delete-no-targets');
  const planPayload = planCard.payload as any;
  planPayload.planId = 'impl-reviewed-delete-no-targets';
  planPayload.implementationPlan.id = 'impl-reviewed-delete-no-targets';
  planPayload.implementationPlan.tasks[0].target = [];
  delete planPayload.implementationPlan.tasks[0].fileOperations;
  planPayload.planReviewReport = report;
  planPayload.requiredFileOperations = report.requiredFileOperations;
  const events: AgentEvent[] = [planCard];
  const session: AgentSession = {
    id: 'session-reviewed-delete-no-targets',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const temporaryGrants: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report,
            },
          ],
        };
      }
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants.push(command.grant);
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-reviewed-delete-no-targets',
              output: { path: 'generic-obsolete.txt' },
            },
            { kind: 'stage.changed', runId: command.runId, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(deleteActionBundleProposal('generic-obsolete.txt'));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-reviewed-delete-no-targets',
    targetId: 'impl-reviewed-delete-no-targets',
    existingEvents: events,
  });

  assertEqual(llmCalls, 1, 'reviewed delete exact grant does not trigger scope repair when task target scopes are empty');
  assertEqual(proposalSubmits, 1, 'reviewed delete exact grant still goes through Kernel PlanReview for the execution batch');
  assertEqual(actionBatchSubmits, 1, 'reviewed delete exact grant submits actionBatch even when implementationPlan task targets are empty');
  assertEqual(temporaryGrants.length, 1, 'reviewed delete exact grant receives one temporary grant');
  assertEqual(temporaryGrants[0]?.resourcePath, 'generic-obsolete.txt', 'reviewed delete exact grant keeps the file-scoped grant target');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'reviewed delete exact grant does not ask for user intervention');
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    false,
    'reviewed delete exact grant does not fail Session admission'
  );
}

async function assertSessionDriverLoopAcceptedExecutionExceptionClosesRun(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-stale.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-preflight-failure',
      sessionId: 'session-preflight-failure',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-preflight-failure',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-preflight-failure',
        content: '# Plan\n\n## Summary\nDelete one reviewed file.',
        actionBundle,
        codeBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingTemporaryGrant',
        planReviewReport: report,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-preflight-failure',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let preflightAppendFailed = false;
  let kernelCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      const hasPreflight = nextEvents.some((event) =>
        event.kind === 'workflow_stage' &&
        (event.payload as any)?.stage === 'accepted_plan.action_batch_preflight'
      );
      if (hasPreflight && !preflightAppendFailed) {
        preflightAppendFailed = true;
        throw new Error('generic preflight append failed');
      }
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit' || command.kind === 'permissionGrantTemporary' || command.kind === 'actionBatchSubmit') {
        kernelCalls += 1;
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + kernelCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-preflight-failure',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(preflightAppendFailed, true, 'preflight append failure was exercised');
  assertEqual(kernelCalls, 0, 'preflight failure stops before Kernel user decision, grant, or actionBatch');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any)?.code === 'accepted_plan_execution_failed'),
    true,
    'preflight failure emits accepted-plan execution diagnostic'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    true,
    'preflight failure closes the run with failed lifecycle'
  );
}

async function assertSessionDriverLoopAcceptedExecutionKernelErrorClosesRun(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-kernel-error.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-kernel-error',
      sessionId: 'session-kernel-error',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-kernel-error',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-kernel-error',
        content: '# Plan\n\n## Summary\nDelete one reviewed file.',
        actionBundle,
        codeBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingTemporaryGrant',
        planReviewReport: report,
        requiredFileOperations: report.requiredFileOperations,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-kernel-error',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: false,
          events: [],
          error: { code: 'generic_kernel_error', message: 'generic Kernel action batch submit failed' },
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-kernel-error',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'Kernel actionBatchSubmit failure path is exercised once');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'error' &&
      String((event.payload as any)?.message ?? '').includes('已确认计划执行链路失败') &&
      String((event.payload as any)?.message ?? '').includes('generic Kernel action batch submit failed')
    ),
    true,
    'Kernel actionBatchSubmit error is projected as an accepted-plan failure while preserving the Kernel error'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any)?.status === 'failed'),
    true,
    'Kernel actionBatchSubmit error closes the run with failed lifecycle'
  );
}

async function assertSessionDriverLoopAcceptedDecisionRecoversUnconsumedExecution(): Promise<void> {
  const proposal = deleteActionBundleProposal('generic-retry.txt') as any;
  const actionBundle = proposal.actionBundle as Record<string, any>;
  const report = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    {
      id: 'plan-card-unconsumed-accepted',
      sessionId: 'session-unconsumed-accepted',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-unconsumed-accepted',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-unconsumed-accepted',
        content: '# Plan\n\n## Summary\nDelete one reviewed file.',
        actionBundle,
        codeBlocks: [],
        commandBlocks: [],
        confirmable: true,
        status: 'awaitingTemporaryGrant',
        planReviewReport: report,
      },
    },
    {
      id: 'plan-accepted-unconsumed',
      sessionId: 'session-unconsumed-accepted',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'accepted',
        runId: 'run-unconsumed-accepted',
        planId: 'bundle-generic-delete',
        confirmable: false,
        report,
      },
    },
    {
      id: 'session-run-unconsumed-running',
      sessionId: 'session-unconsumed-accepted',
      ts: '2026-01-01T00:00:00.002Z',
      kind: 'session_run_state',
      payload: {
        status: 'running',
        phase: 'executing_accepted_plan',
        reason: 'accepted_plan_execution',
        runId: 'run-unconsumed-accepted',
        decisionOwner: { kind: 'plan', runId: 'run-unconsumed-accepted', planId: 'bundle-generic-delete', targetId: 'bundle-generic-delete' },
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-unconsumed-accepted',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [{ kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } }] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-unconsumed-accepted',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'trace/plan_accept_noop'), false, 'unconsumed accepted plan is not treated as stale');
  assertEqual(actionBatchSubmits, 1, 'unconsumed accepted plan can retry into actionBatchSubmit');
}

async function assertSessionDriverLoopRequirementAcceptedActionBundleWaitsForExplicitPlanConfirmation(): Promise<void> {
  const events: AgentEvent[] = [
    {
      id: 'requirement-generic-auto-plan',
      sessionId: 'session-requirement-auto-plan',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: {
        title: 'Requirement confirmation',
        summary: 'Confirm a generic side-effect choice.',
        content: 'Confirm the generic side-effect scope.',
        originalUserRequest: 'Create one generic reviewed workspace update.',
        runId: 'run-requirement-auto-plan',
        requirementId: 'requirement-generic-auto-plan',
        status: 'waitingUserConfirmation',
        confirmable: true,
        attachments: [],
        interactionOverlay: true,
        parentRunId: 'run-requirement-parent',
        parentPhase: 'provider_proposing',
        interactionRunId: 'run-requirement-auto-plan',
        interactionId: 'requirement-generic-auto-plan',
        sourceInteractionId: 'requirement-generic-auto-plan',
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-requirement-auto-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let userDecisionSubmits = 0;
  let actionBatchSubmits = 0;
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId ?? 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId ?? 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'permissionGrantTemporary') {
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            {
              kind: 'action_batch.accepted',
              runId: command.runId,
              sessionId: session.id,
              actionCount: 1,
            },
            {
              kind: 'work_unit.queued',
              runId: command.runId,
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic-auto-plan', actionId: 'write-generic-output', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-generic-auto-plan',
              result: { ok: true },
            },
            { kind: 'stage.changed', runId: command.runId, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + userDecisionSubmits + actionBatchSubmits + reviewFactsRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-requirement-auto-plan',
    targetId: 'requirement-generic-auto-plan',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'requirement accept generates one actionBundle plan through provider');
  assertEqual(userDecisionSubmits, 0, 'requirement accept does not submit a Kernel plan decision');
  assertEqual(actionBatchSubmits, 0, 'requirement accept does not continue into actionBatchSubmit');
  assertEqual(reviewFactsRequests, 0, 'requirement accept does not reach review facts before explicit plan confirmation');
  assertEqual(result.events.some((event) => event.kind === 'trace/plan_accept_noop'), false, 'requirement accept generates a fresh plan instead of a stale noop');
  assertEqual(result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any).reason === 'accepted_plan_execution'), false, 'requirement accept does not emit accepted-plan execution lifecycle');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  assertEqual(Boolean(planCard), true, 'requirement accept generates a confirmable actionBundle plan card');
  assertEqual((planCard?.payload as any)?.interactionOverlay, true, 'overlay requirement resume keeps plan card in the parent interaction flow');
  assertEqual((planCard?.payload as any)?.parentRunId, 'run-requirement-parent', 'overlay requirement resume keeps parentRunId on plan card');
  assertEqual(
    result.events.some((event) => event.kind === 'plan_review' && (event.payload as any)?.status === 'accepted'),
    false,
    'requirement accept does not auto-accept the generated plan'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'plan_review'
    ),
    true,
    'generated plan waits for explicit plan confirmation'
  );
}

async function assertSessionDriverLoopActionBundleAdmissionRepairsDirectoryDeleteBeforePlanCard(): Promise<void> {
  const events: AgentEvent[] = [genericDirectoryResourceEvent('session-admission-repair', 'generic-dir', ['generic-dir/inside.txt'])];
  const session: AgentSession = {
    id: 'session-admission-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      return planKernel(request, session.id, submittedPlans);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) return jsonLlmResponse(deleteActionBundleProposal('generic-dir'));
      return jsonLlmResponse(deleteActionBundleProposal('generic-dir/inside.txt'));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: 'Delete the generic cleanup targets listed in the attached workspace evidence.',
    existingEvents: events,
    appendUserMessage: false,
    resumeResourcePackets: true,
  });

  const planCards = result.events.filter((event) => event.kind === 'plan_card');
  assertEqual(llmCalls, 2, 'directory delete admission repair calls provider once for a corrected file-level plan');
  assertEqual(proposalSubmits, 1, 'only the repaired file-level actionBundle enters Kernel PlanReview');
  assertEqual(planCards.length, 1, 'only the repaired actionBundle becomes a confirmable plan card');
  assertEqual(
    planCards.some((event) => (event.payload as any).actionBundle?.actions?.[0]?.targetPath === 'generic-dir/inside.txt'),
    true,
    'confirmable plan card contains a concrete file-level delete target'
  );
  assertEqual(
    submittedPlans.some((plan) => plan.payload?.actionBundle?.actions?.[0]?.targetPath === 'generic-dir'),
    false,
    'directory delete target is not submitted to Kernel PlanReview'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'workflow_stage' && (event.payload as any).stage === 'action_bundle_admission.repairing'),
    true,
    'admission repair emits a reusable workflow_stage projection'
  );
}

async function assertSessionDriverLoopActionBundleAdmissionRejectsRepeatedDirectoryDelete(): Promise<void> {
  const events: AgentEvent[] = [genericDirectoryResourceEvent('session-admission-reject', 'generic-dir', ['generic-dir/inside.txt'])];
  const session: AgentSession = {
    id: 'session-admission-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') proposalSubmits += 1;
      return planKernel(request, session.id, submittedPlans);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(deleteActionBundleProposal('generic-dir'));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: 'Delete the generic cleanup targets listed in the attached workspace evidence.',
    existingEvents: events,
    appendUserMessage: false,
    resumeResourcePackets: true,
  });

  assertEqual(llmCalls, 2, 'repeated invalid directory delete receives only one admission repair attempt');
  assertEqual(proposalSubmits, 0, 'repeated invalid directory delete never enters Kernel PlanReview');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'repeated invalid directory delete does not produce a confirmable plan card');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any).code === 'action_bundle_admission_failed'),
    true,
    'repeated invalid directory delete produces a structured admission diagnostic'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any).status === 'failed'),
    true,
    'repeated invalid directory delete closes the run with failed lifecycle'
  );
  assertEqual(submittedPlans.length, 0, 'no invalid plan is submitted through the Kernel test port');
}

async function assertSessionDriverLoopAcceptedScopeRejectsDirectoryDeleteFromResourceEvidence(): Promise<void> {
  const deleteProposal = deleteActionBundleProposal('generic-dir');
  const actionBundle = deleteProposal.actionBundle as Record<string, any>;
  const events: AgentEvent[] = [
    {
      id: 'resource-generic-directory',
      sessionId: 'session-delete-directory-preflight',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'tool_result',
      payload: {
        output: {
          id: 'resource-packet-generic-directory',
          workspaceScopeKey: 'workspace',
          requestId: 'resource-request-generic-directory',
          items: [{
            requestItemId: 'item-directory',
            manifestEntryId: 'attachment-generic',
            status: 'resolved',
            contentKind: 'directoryTree',
            nodes: [
              {
                name: 'generic-dir',
                path: 'generic-dir',
                type: 'directory',
                children: [{ name: 'inside.txt', path: 'generic-dir/inside.txt', type: 'file', children: null }],
              },
            ],
          }],
        },
      },
    },
    {
      id: 'plan-delete-directory-preflight',
      sessionId: 'session-delete-directory-preflight',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-delete-directory-preflight',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-delete-directory-preflight',
        title: 'Generic delete plan',
        summary: 'Delete a generic target after review.',
        content: '# Plan\n\n## Summary\nDelete a generic target after review.',
        actionBundle,
        codeBlocks: [],
        commandBlocks: [],
        planReviewReport: proposalReviewReport(actionBundle),
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-delete-directory-preflight',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let userDecisionSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') userDecisionSubmits += 1;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-delete-directory-preflight',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(userDecisionSubmits, 0, 'directory delete preflight does not submit the plan decision to Kernel');
  assertEqual(actionBatchSubmits, 0, 'directory delete preflight does not submit an action batch');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any).code === 'accepted_plan_action_batch_preflight_failed'),
    true,
    'directory delete preflight produces a structured diagnostic'
  );
  assertEqual(
    result.events.some((event) => event.kind === 'session_run_state' && (event.payload as any).status === 'failed'),
    true,
    'directory delete preflight closes the run with failed lifecycle'
  );
}

async function assertSessionDriverLoopAcceptedScopeExecutesReviewedDirectoryDelete(): Promise<void> {
  const deleteProposal = deleteActionBundleProposal('generic-dir') as any;
  const actionBundle = deleteProposal.actionBundle as Record<string, any>;
  actionBundle.actions[0].targetKind = 'directory';
  actionBundle.actions[0].targetResourceKind = 'directory';
  actionBundle.actions[0].recursive = true;
  const planReviewReport = proposalReviewReport(actionBundle);
  const events: AgentEvent[] = [
    genericDirectoryResourceEvent('session-delete-directory-reviewed', 'generic-dir', ['generic-dir/inside.txt']),
    {
      id: 'plan-delete-directory-reviewed',
      sessionId: 'session-delete-directory-reviewed',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-delete-directory-reviewed',
        planId: 'bundle-generic-delete',
        proposalId: 'proposal-delete-directory-reviewed',
        title: 'Generic delete plan',
        summary: 'Delete a generic directory after review.',
        content: '# Plan\n\n## Summary\nDelete a generic directory after review.',
        actionBundle,
        codeBlocks: [],
        commandBlocks: [],
        planReviewReport,
        requiredFileOperations: planReviewReport.requiredFileOperations,
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-delete-directory-reviewed',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let userDecisionSubmits = 0;
  let actionBatchSubmits = 0;
  const temporaryGrants: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants.push(command.grant);
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: command.batch },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-generic-directory-delete',
              output: { path: 'generic-dir', kind: 'directory', recursive: true },
            },
          ],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + actionBatchSubmits + temporaryGrants.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-delete-directory-reviewed',
    targetId: 'bundle-generic-delete',
    existingEvents: events,
  });

  assertEqual(userDecisionSubmits, 1, 'reviewed directory delete submits the plan decision');
  assertEqual(actionBatchSubmits, 1, 'reviewed directory delete submits an action batch');
  assertEqual(temporaryGrants.length, 1, 'reviewed directory delete receives one scoped temporary grant');
  assertEqual(temporaryGrants[0]?.resourceKind, 'workspaceDirectory', 'reviewed directory delete uses a directory scoped grant');
  assertEqual(temporaryGrants[0]?.resourcePath, 'generic-dir', 'reviewed directory delete grant is scoped to the confirmed directory');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && (event.payload as any).code === 'accepted_plan_action_batch_preflight_failed'),
    false,
    'reviewed directory delete does not fail Session preflight'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesBatch(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-auto', 'run-accepted-plan-auto')];
  const session: AgentSession = {
    id: 'session-accepted-plan-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let temporaryGrants = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            {
              kind: 'action_batch.accepted',
              runId: 'run-generic',
              sessionId: session.id,
              batch: { planId: command.batch?.planId },
            },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              output: { path: 'generic-output.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + temporaryGrants + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-auto',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 1, 'accepted implementationPlan still submits actionBundle to Kernel PlanReview for audit');
  assertEqual(actionBatchSubmits, 1, 'accepted implementationPlan auto-submits in-scope actionBundle to Kernel execution');
  assertEqual(temporaryGrants, 1, 'accepted implementationPlan grants scoped workspace write permission for in-scope batch');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'accepted implementationPlan execution does not create a second confirmable plan card');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'running' &&
      (event.payload as any)?.reason === 'accepted_plan_execution'
    ),
    true,
    'accepted implementationPlan execution records running session state'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanNormalizesWriteBatchForKernel(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-normalize', 'run-accepted-plan-normalize')];
  const session: AgentSession = {
    id: 'session-accepted-plan-normalize',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let submittedBatch: any;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        submittedBatch = command.batch;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              output: { path: 'generic-output.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-normalize',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assert(Boolean(submittedBatch), 'accepted implementationPlan submits a normalized action batch');
  const action = submittedBatch.actionBundle.actions[0];
  const block = submittedBatch.codeBlocks[0];
  assertEqual(action.kind, 'write', 'fs.write action keeps explicit write kind before Kernel submit');
  assertEqual(action.targetPath, 'generic-output.txt', 'fs.write action has explicit targetPath before Kernel submit');
  assertEqual(action.resourceScope[0], 'generic-output.txt', 'fs.write action keeps concrete resourceScope before Kernel submit');
  assertEqual(block.id, 'generic-block', 'codeBlock keeps canonical id before Kernel submit');
  assertEqual(block.blockId, 'generic-block', 'codeBlock also carries blockId compatibility field before Kernel submit');
  assertEqual(block.path, 'generic-output.txt', 'codeBlock keeps path before Kernel submit');
  assertEqual(block.targetPath, 'generic-output.txt', 'codeBlock carries targetPath before Kernel submit');
}

async function assertSessionDriverLoopAcceptedImplementationPlanPrefersTargetPathOverRootResourceScope(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-root-scope-targetpath', 'run-root-scope-targetpath')];
  const planPayload = events[0].payload as any;
  planPayload.planId = 'impl-root-file-write';
  planPayload.implementationPlan.id = 'impl-root-file-write';
  planPayload.implementationPlan.title = 'Generic root file write plan';
  planPayload.implementationPlan.summary = 'Create one generic root-level workspace file.';
  planPayload.implementationPlan.tasks = [{
    taskId: 'task-root-file-write',
    title: 'Create root-level script',
    target: ['root-output.sh'],
    scope: 'Create one generic root-level file already listed in the accepted plan.',
    dependencies: [],
    capability: 'fs.write',
    fileOperations: [{
      operation: 'create',
      capability: 'fs.write',
      targetPath: 'root-output.sh',
      reason: 'Create the accepted root-level file.',
    }],
    acceptanceCriteria: ['Kernel records the root-level write fact.'],
    failureCriteria: ['Stop if the action tries to write the workspace root instead of the file.'],
  }];
  const session: AgentSession = {
    id: 'session-root-scope-targetpath',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let proposalSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        assertEqual(Array.isArray(actionBundle.accessScopes), false, 'canonical root actionBundle does not submit provider accessScopes');
        assertEqual(
          JSON.stringify(actionBundle.actions ?? []).includes('"accessScopes"'),
          false,
          'canonical root action does not submit provider accessScopes'
        );
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: command.runId,
              sessionId: session.id,
              workUnit: { id: 'work-unit-root-output', actionId: 'write-root-output', status: 'queued', writeSet: ['root-output.sh'] },
            },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-root-output',
              output: { path: 'root-output.sh' },
            },
            { kind: 'stage.changed', runId: command.runId, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      const proposal = genericWriteProposal(false);
      proposal.codeBlocks = [{
        blockId: 'root-output-block',
        targetPath: 'root-output.sh',
        language: 'bash',
        operation: 'create',
        contentLines: ['#!/bin/sh', 'echo generic'],
      }];
      (proposal.actionBundle as any).id = 'bundle-root-output';
      (proposal.actionBundle as any).goal = 'Create the accepted root-level file.';
      (proposal.actionBundle as any).actions = [{
        actionId: 'write-root-output',
        toolId: 'fs.write',
        args: { path: 'root-output.sh', sourceBlockId: 'root-output-block' },
        description: 'Write root output',
      }];
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + repairRequests.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-root-scope-targetpath',
    targetId: 'impl-root-file-write',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'accepted plan root-level write uses targetPath before root resourceScope');
  assertEqual(proposalSubmits, 1, 'accepted plan batch still goes through Kernel PlanReview after scope narrowing');
  assertEqual(repairRequests.length, 0, 'root resourceScope does not trigger accepted-plan scope repair when targetPath is concrete');
}

async function assertSessionDriverLoopAcceptedImplementationPlanRepairsPlanReviewRootAccessScope(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-planreview-root-scope-repair', 'run-planreview-root-scope-repair')];
  const session: AgentSession = {
    id: 'session-planreview-root-scope-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const repairRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        if (proposalSubmits === 1) {
          return {
            ok: true,
            events: [
              { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
              {
                kind: 'proposal.reviewed',
                runId: command.runId,
                sessionId: session.id,
                proposalId: command.proposal?.proposalId,
                report: {
                  ...proposalReviewReport(actionBundle),
                  status: 'needsRevision',
                  blockedReasons: ['actionBundle access scope . (workspaceModule) access scope must not be the workspace root'],
                  findings: [{ code: 'access_scope_root', message: 'access scope must not be the workspace root' }],
                  kernelGeneratedPermissionSummary: 'Kernel preflight: status=needsRevision; root access scope rejected.',
                },
              },
            ],
          };
        }
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              output: { path: 'generic-output.txt' },
            },
            { kind: 'stage.changed', runId: command.runId, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-planreview-root-scope-repair',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 2, 'Kernel needsRevision triggers one automatic ProposalReview repair');
  assertEqual(actionBatchSubmits, 1, 'repaired accepted-plan batch continues to actionBatchSubmit');
  assertEqual(repairRequests.length, 1, 'Session asks provider for one controlled PlanReview repair');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'repairable ProposalReview issue does not trigger user intervention');
  assert(
    JSON.stringify(repairRequests[0].messages).includes('contentLines') &&
      JSON.stringify(repairRequests[0].messages).includes('toolId'),
    'PlanReview repair prompt uses canonical toolId/contentLines protocol'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanPreservesExecutionRoot(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-root', root),
    acceptedImplementationPlanCardEvent('session-accepted-plan-root', 'run-accepted-plan-root'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-root',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let runCreateAttachments: any[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        runCreateAttachments = command.input?.attachments ?? [];
        return fakeKernel(request);
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-root',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(runCreateAttachments.length, 1, 'accepted implementationPlan continuation sends one execution root attachment');
  assertEqual(runCreateAttachments[0]?.absolutePath, root, 'accepted implementationPlan continuation preserves the primary root');
}

async function assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesMultiTargetBatch(): Promise<void> {
  const events = [multiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-multi', 'run-accepted-plan-multi')];
  const session: AgentSession = {
    id: 'session-accepted-plan-multi',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') {
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-one', actionId: 'write-generic-one', status: 'queued', writeSet: ['generic-one.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-one',
              output: { path: 'generic-one.txt' },
            },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-two', actionId: 'write-generic-two', status: 'queued', writeSet: ['generic-two.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-two',
              output: { path: 'generic-two.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(multiWriteProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-multi',
    targetId: 'impl-generic-multi',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'multi-target accepted implementationPlan batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'multi-target accepted implementationPlan batch is auto-executed');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'multi-target in-scope batch does not become a user intervention');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.length === 0
    ),
    true,
    'multi-target batch records an accepted-plan checkpoint with no remaining tasks'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSplitsCommaSeparatedTargets(): Promise<void> {
  const paths = Array.from({ length: 6 }, () => `${randomSmokeToken('dir')}/${randomSmokeToken('file')}.txt`);
  const sessionId = `session-${randomSmokeToken('comma')}`;
  const runId = `run-${randomSmokeToken('comma')}`;
  const events = [commaSeparatedTargetsAcceptedImplementationPlanCardEvent(sessionId, runId, paths)];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let submittedPaths: string[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') {
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const actions = Array.isArray(command.batch?.actionBundle?.actions) ? command.batch.actionBundle.actions : [];
        submittedPaths = actions.map((action: any) => String(action?.args?.path ?? action?.targetPath ?? ''));
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId, sessionId, batch: { planId: command.batch?.planId } },
            ...submittedPaths.flatMap((path, index) => [
              {
                kind: 'work_unit.queued',
                runId,
                sessionId,
                workUnit: { id: `work-unit-${index}`, actionId: actions[index]?.actionId, status: 'queued', writeSet: [path] },
              },
              {
                kind: 'work_unit.completed',
                runId,
                sessionId,
                workUnitId: `work-unit-${index}`,
                output: { path },
              },
            ]),
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(randomMultiWriteProposal(paths)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-random-comma',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'comma-separated accepted targets still submit one Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'comma-separated accepted targets execute in one actionBatch');
  assertEqual(submittedPaths.length, paths.length, 'all random targets are submitted to Kernel');
  assertEqual([...submittedPaths].sort().join('\n'), [...paths].sort().join('\n'), 'submitted target set matches the accepted comma-separated target list');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'comma-separated accepted targets do not trigger user intervention');
  assert(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.length === 0
    ),
    'comma-separated target batch completes the accepted task'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAllowsBriefExecutionBatchPlan(): Promise<void> {
  const path = `${randomSmokeToken('single')}/${randomSmokeToken('target')}.txt`;
  const sessionId = `session-${randomSmokeToken('brief')}`;
  const runId = `run-${randomSmokeToken('brief')}`;
  const events = [commaSeparatedTargetsAcceptedImplementationPlanCardEvent(sessionId, runId, [path])];
  const session: AgentSession = {
    id: sessionId,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId, sessionId, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId,
              sessionId,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId, sessionId, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId,
              sessionId,
              workUnit: { id: 'work-unit-brief', actionId: 'write-brief', status: 'queued', writeSet: [path] },
            },
            {
              kind: 'work_unit.completed',
              runId,
              sessionId,
              workUnitId: 'work-unit-brief',
              output: { path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(randomMultiWriteProposal([path], { briefUserPlan: true })),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId,
    kind: 'plan',
    decision: 'accept',
    runId,
    targetId: 'impl-random-comma',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'brief accepted-plan execution batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'brief accepted-plan execution batch is submitted to Kernel');
  assertEqual(
    result.events.some((event) => event.kind === 'error' && String((event.payload as any)?.message ?? '').includes('userPlan')),
    false,
    'brief accepted-plan execution batch is not rejected by detailed initial-plan userPlan validation'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanKeepsContinuationNonExecutable(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-continuation', 'run-accepted-plan-continuation')];
  const session: AgentSession = {
    id: 'session-accepted-plan-continuation',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let submittedActionCount = 0;
  let submittedContinuationCount = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const actionBundle = command.batch?.actionBundle as Record<string, any> | undefined;
        submittedActionCount = Array.isArray(actionBundle?.actions) ? actionBundle.actions.length : 0;
        submittedContinuationCount = Array.isArray(actionBundle?.continuationExpectations)
          ? actionBundle.continuationExpectations.length
          : 0;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-resource-resume', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-continuation-current',
              actionId: 'write-continuation-current',
              output: { path: 'generic-output.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const proposal = singleTargetWriteProposal('generic-output.txt', 'continuation-current') as any;
      proposal.actionBundle = {
        ...proposal.actionBundle,
        actions: [{
          actionId: 'write-continuation-current',
          toolId: 'fs.write',
          args: { path: 'generic-output.txt', sourceBlockId: 'code-continuation-current' },
          description: 'Write current generic output.',
        }],
        continuationExpectations: ['Continue with another generic target after review.'],
      };
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-continuation',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'continuation smoke submits current actionBundle to Kernel PlanReview once');
  assertEqual(actionBatchSubmits, 1, 'continuation smoke submits current action batch once');
  assertEqual(submittedActionCount, 1, 'continuation smoke keeps executable actions limited to the current action');
  assertEqual(submittedContinuationCount, 1, 'continuation smoke preserves one non-executable continuation note');
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsMergeIndependentTasks(): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents', 'run-accepted-plan-subagents')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedPlans.push(command.proposal);
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-resource-resume', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-one',
              output: { path: 'generic-one.txt' },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-two',
              output: { path: 'generic-two.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (targetPath === 'generic-one.txt') return jsonLlmResponse(singleTargetModuleDraft('generic-one.txt', 'one'));
      if (targetPath === 'generic-two.txt') return jsonLlmResponse(singleTargetModuleDraft('generic-two.txt', 'two'));
      throw new Error('sub-agent merge smoke expected only sliced provider calls');
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + llmCalls + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents',
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(llmCalls, 2, 'sub-agent auto mode calls provider once per independent task slice');
  assertEqual(
    proposalSubmits,
    1,
    `sub-agent fragments are merged into one Kernel PlanReview submission (llmCalls=${llmCalls}, actionBatchSubmits=${actionBatchSubmits}, deltas=${deltas.length})`
  );
  assertEqual(actionBatchSubmits, 1, 'merged sub-agent fragments are submitted to Kernel once');
  assertEqual(
    deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_plan.created') &&
      deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_dispatch.announced') &&
      deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_merge.started') &&
      deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_merge.completed'),
    true,
    'sub-agent merge emits stable parent progress deltas'
  );
  assertEqual(
    deltas.filter((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_branch.request_sent').length,
    2,
    'sub-agent branch lifecycle records provider request dispatch for each slice'
  );
  assertEqual(
    deltas.filter((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_branch.waiting_merge').length,
    2,
    'sub-agent branch lifecycle records merge-barrier waiting for each slice'
  );
  assertEqual(
    deltas.filter((delta) => (delta as any).branchId && (delta as any).subAgentId).length >= 2,
    true,
    'branch deltas carry branch and sub-agent metadata'
  );
  const actionBundle = submittedPlans[0]?.payload?.actionBundle;
  assertEqual(Array.isArray(actionBundle?.actions) && actionBundle.actions.length, 2, 'merged actionBundle contains both independent task actions');
  assertEqual(typeof submittedPlans[0]?.payload?.narration, 'undefined', 'merged sub-agent batch does not create a formal assistant narration');
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsScheduleExplicitDag(): Promise<void> {
  const events = [explicitDagAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-dag', 'run-accepted-plan-subagents-dag')];
  const deltas: unknown[] = [];
  const providerTargets: string[] = [];
  const providerPrompts: string[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-dag',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedPlans.push(command.proposal);
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-dag-alpha', output: { path: 'generic-alpha/output.txt' } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-dag-beta', output: { path: 'generic-beta/output.txt' } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-dag-gamma', output: { path: 'generic-gamma/output.txt' } },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = String(deepcode?.subAgent?.targetPath ?? '');
      providerTargets.push(targetPath);
      const userMessage = request.messages.find((message) => message.role === 'user')?.content ?? '';
      providerPrompts.push(userMessage);
      assert(userMessage.includes('Sub-agent file-node packet'), 'sub-agent request uses file-node packet contract');
      assert(userMessage.includes('ExecutionFlowGraph file pipeline'), 'sub-agent request includes the DAG file pipeline summary');
      assert(userMessage.includes('Assigned file node:'), 'sub-agent request identifies the assigned file node');
      assert(!userMessage.includes('Prompt envelope size summary'), 'sub-agent request omits full parent dynamic prompt');
      if (targetPath === 'generic-alpha/output.txt') return jsonLlmResponse(singleTargetModuleDraft(targetPath, 'dag-alpha'));
      if (targetPath === 'generic-beta/output.txt') return jsonLlmResponse(singleTargetModuleDraft(targetPath, 'dag-beta'));
      if (targetPath === 'generic-gamma/output.txt') return jsonLlmResponse(singleTargetModuleDraft(targetPath, 'dag-gamma'));
      throw new Error(`unexpected DAG target: ${targetPath}`);
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + providerTargets.length + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-dag',
    targetId: 'impl-generic-dag',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(providerTargets.length, 3, 'explicit DAG schedules all three ready/unlocked nodes');
  assertEqual(new Set(providerTargets.slice(0, 2)).size, 2, 'first scheduler window starts two independent nodes');
  assert(providerTargets.slice(0, 2).includes('generic-alpha/output.txt'), 'first scheduler window includes the first independent node');
  assert(providerTargets.slice(0, 2).includes('generic-beta/output.txt'), 'first scheduler window includes the second independent node');
  assertEqual(providerTargets[2], 'generic-gamma/output.txt', 'dependent node starts only after predecessors complete');
  assert(providerPrompts.some((prompt) => prompt.includes('"nodeId": "node-generic-gamma"')), 'DAG prompt includes downstream node context');
  const nodeStageIndex = (stage: string, nodeId: string): number => deltas.findIndex((delta) =>
    (delta as any).type === 'stage_delta' &&
    (delta as any).stage === stage &&
    (delta as any).payload?.nodeId === nodeId
  );
  const alphaCompleted = nodeStageIndex('subagent_node.completed', 'node-generic-alpha');
  const betaCompleted = nodeStageIndex('subagent_node.completed', 'node-generic-beta');
  const gammaStarted = nodeStageIndex('subagent_node.started', 'node-generic-gamma');
  const alphaReady = nodeStageIndex('subagent_node.ready', 'node-generic-alpha');
  const betaReady = nodeStageIndex('subagent_node.ready', 'node-generic-beta');
  assert(alphaReady >= 0 && betaReady >= 0, 'DAG file nodes emit ready projection before queued/start');
  assert(alphaCompleted >= 0 && betaCompleted >= 0 && gammaStarted >= 0, 'DAG node lifecycle emits completed and started node events');
  assert(gammaStarted > alphaCompleted && gammaStarted > betaCompleted, 'dependent node projection starts after predecessor completion');
  assertEqual(proposalSubmits, 1, 'DAG module drafts are merged into one Parent PlanReview submission');
  assertEqual(actionBatchSubmits, 1, 'DAG module drafts reach Kernel through one Parent actionBatch');
  const actionBundle = submittedPlans[0]?.payload?.actionBundle;
  assertEqual(Array.isArray(actionBundle?.actions) && actionBundle.actions.length, 3, 'DAG merge submits all completed node draft files');
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsStreamPartFrames(): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-stream', 'run-accepted-plan-subagents-stream')];
  const deltas: unknown[] = [];
  const draftFrames: Array<Record<string, unknown>> = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-stream',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let streamCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'draftLedgerSubmit') {
        draftFrames.push(command.frame);
        return {
          ok: true,
          events: [
            {
              kind: 'draft.chunk',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.chunk', frame: command.frame },
            },
          ],
        };
      }
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-stream-one', output: { path: 'generic-one.txt' } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-stream-two', output: { path: 'generic-two.txt' } },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('sub-agent streaming smoke should use llmChatStream');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const branch = deepcode?.subAgent as Record<string, string> | undefined;
      if (!branch?.targetPath) throw new Error('sub-agent streaming smoke expected branch metadata');
      streamCalls += 1;
      const frame = {
        schemaVersion: 'deepcode.agent.stream.part.v1',
        partKind: streamCalls % 2 === 1 ? 'thinkingDelta' : 'actionDraftChunk',
        draftId: `draft-${branch.branchId}`,
        frameId: `frame-${branch.branchId}`,
        branchId: branch.branchId,
        subAgentId: branch.subAgentId,
        mergeGroupId: branch.mergeGroupId,
        targetPath: branch.targetPath,
        capability: 'fs.write',
        sequence: 1,
        chunk: `generic progress for ${branch.targetPath}`,
      };
      await onEvent({ type: 'provider_delta', chunk: { type: 'delta', content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>` } });
      return jsonLlmResponse(singleTargetModuleDraft(branch.targetPath, `streamed-${streamCalls}`));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamCalls + proposalSubmits + actionBatchSubmits + deltas.length + draftFrames.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-stream',
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(streamCalls, 2, 'sub-agent streaming path calls provider once per independent slice');
  assertEqual(draftFrames.length, 2, 'sub-agent part frames are submitted to Kernel draft ledger');
  assertEqual(proposalSubmits, 1, 'streamed sub-agent fragments are merged into one Kernel PlanReview submission');
  assertEqual(actionBatchSubmits, 1, 'streamed sub-agent fragments are executed as one merged batch');
  assertEqual(
    deltas.filter((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_branch.first_delta').length,
    2,
    'sub-agent streaming emits first-delta lifecycle events'
  );
  assertEqual(
    deltas.some((delta) => (delta as any).type === 'part_delta' && (delta as any).branchId && (delta as any).subAgentId),
    true,
    'sub-agent structured part frames stay branch-scoped'
  );
  assertEqual(
    deltas.some((delta) => (delta as any).type === 'assistant_delta' && (delta as any).branchId),
    false,
    'sub-agent raw assistant deltas are not exposed as branch assistant text'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsStalledBranchFallback(): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-stalled', 'run-accepted-plan-subagents-stalled')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-stalled',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentStreamCalls = 0;
  let subAgentStreamCalls = 0;
  let serialFallbackCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedPlans.push(command.proposal);
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-stalled-fallback-one', output: { path: 'generic-one.txt' } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-stalled-fallback-two', output: { path: 'generic-two.txt' } },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('stalled sub-agent smoke should use streaming provider path');
    },
    llmChatStream: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const branch = deepcode?.subAgent as Record<string, string> | undefined;
      if (branch?.targetPath) {
        subAgentStreamCalls += 1;
        if (subAgentStreamCalls === 1) {
          return jsonLlmResponse(singleTargetModuleDraft(branch.targetPath, 'stalled-smoke-first-branch'));
        }
        return new Promise<ApiResponse<LlmChatResult>>(() => {
          // Intentionally unresolved; the Session no-delta timeout owns this branch failure.
        });
      }
      parentStreamCalls += 1;
      serialFallbackCalls += 1;
      return jsonLlmResponse(singleTargetWriteProposal('generic-two.txt', 'stalled-serial-fallback'));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentStreamCalls + subAgentStreamCalls + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-stalled',
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
    subAgentNoDeltaTimeoutMs: 1,
    subAgentTotalTimeoutMs: 50,
  });

  assertEqual(subAgentStreamCalls, 2, 'stalled smoke starts both sub-agent branches');
  assertEqual(parentStreamCalls, 1, 'stalled branch is reclaimed through one compact parent serial fallback provider call');
  assertEqual(serialFallbackCalls, 1, 'stalled branch uses the serial slice fallback path once');
  assertEqual(proposalSubmits, 1, 'stalled branch serial fallback submits one Parent proposal');
  assertEqual(actionBatchSubmits, 1, 'stalled branch serial fallback reaches Kernel execution');
  const actionBundle = submittedPlans[0]?.payload?.actionBundle;
  assertEqual(Array.isArray(actionBundle?.actions) && actionBundle.actions.length, 1, 'stalled branch submits only the Parent fallback action');
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_branch.stalled' &&
      (delta as any).status === 'failed'
    ),
    true,
    'no-delta timeout projects a stalled branch before failure'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_node.reclaimed' &&
      (delta as any).payload?.reason
    ),
    true,
    'stalled branch is reclaimed for parent serial handling'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_serial_fallback.completed'
    ),
    true,
    'stalled branch reaches the compact serial fallback path'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      String((delta as any).stage ?? '').startsWith('subagent_parent_fallback')
    ),
    false,
    'stalled branch does not use broad parent fallback'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsDiscardFailedBranchAndFallback(): Promise<void> {
  await runSubAgentFailureFallbackSmoke(
    'diagnostic',
    () => jsonLlmResponse(genericDiagnosticProposal('generic branch diagnostic'))
  );
  await runSubAgentFailureFallbackSmoke(
    'parse-failure',
    () => ({
      ok: true,
      data: {
        chunks: [{ type: 'reasoning_delta', content: 'generic invalid reasoning' }, { type: 'done' }],
        assistantMessage: {
          role: 'assistant',
          reasoningContent: 'generic invalid reasoning',
          content: '{invalid-json',
        },
      },
    })
  );
  await runSubAgentFailureFallbackSmoke(
    'action-bundle-violation',
    () => jsonLlmResponse(singleTargetWriteProposal('generic-two.txt', 'subagent-action-bundle-violation'))
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSerialFallbackProviderFailure(): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-fallback-provider-failure', 'run-accepted-plan-subagents-fallback-provider-failure')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-fallback-provider-failure',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let serialFallbackCalls = 0;
  let broadParentFallbackCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return fakeKernel(request);
      }
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
        if (targetPath === 'generic-one.txt' || targetPath === 'generic-two.txt') {
          return jsonLlmResponse(genericDiagnosticProposal('generic branch diagnostic provider failure'));
        }
        throw new Error(`unexpected sub-agent target in provider failure smoke: ${targetPath}`);
      }
      parentLlmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      if (promptText.includes('DeepCode serial slice fallback')) serialFallbackCalls += 1;
      if (promptText.includes('compact parent fallback step')) broadParentFallbackCalls += 1;
      assert(promptText.includes('DeepCode serial slice fallback'), 'serial fallback provider request uses the compact slice contract');
      return {
        ok: false,
        message: 'LLM provider returned HTTP 400',
        error: 'LLM provider returned HTTP 400',
      };
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-fallback-provider-failure',
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 2, 'provider failure smoke attempts both independent sub-agent branches');
  assertEqual(parentLlmCalls, 1, 'provider failure smoke attempts the parent fallback provider once');
  assertEqual(serialFallbackCalls, 1, 'provider failure smoke uses one serial fallback provider request');
  assertEqual(broadParentFallbackCalls, 0, 'provider failure smoke does not use broad parent fallback');
  assertEqual(proposalSubmits, 0, 'provider failure smoke does not submit fallback work to Kernel PlanReview');
  assertEqual(actionBatchSubmits, 0, 'provider failure smoke does not submit fallback work to Kernel execution');
  assertEqual(result.events.some((event) => event.kind === 'error'), false, 'provider failure smoke does not emit an unhandled Session error event');
  assert(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.diagnostic === true &&
      String((event.payload as any)?.content ?? (event.payload as any)?.summary ?? '').includes('Sub-agent serial fallback provider call failed')
    ),
    'provider failure smoke emits a terminal diagnostic with the provider failure reason'
  );
  assert(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_serial_fallback.failed' &&
      (delta as any).status === 'failed'
    ),
    'provider failure smoke projects the parent fallback failure'
  );
}

async function runSubAgentFailureFallbackSmoke(
  caseName: string,
  failedBranchResponse: () => ApiResponse<LlmChatResult>
): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent(`session-accepted-plan-subagents-fallback-${caseName}`, `run-accepted-plan-subagents-fallback-${caseName}`)];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: `session-accepted-plan-subagents-fallback-${caseName}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let serialFallbackCalls = 0;
  let broadParentFallbackCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedPlans.push(command.proposal);
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: {
                id: 'work-unit-resource-resume',
                actionId: 'write-generic-output',
                status: 'queued',
                writeSet: ['generic-output.txt'],
              },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-fallback-one',
              actionId: `write-reclaimed-${caseName}`,
              output: { path: 'generic-one.txt' },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-fallback-two',
              actionId: `write-reclaimed-${caseName}`,
              output: { path: 'generic-two.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
        if (targetPath === 'generic-one.txt') return jsonLlmResponse(singleTargetModuleDraft('generic-one.txt', `fallback-${caseName}-one`));
        if (targetPath === 'generic-two.txt') return failedBranchResponse();
        throw new Error(`unexpected sub-agent target in fallback smoke: ${targetPath}`);
      }
      parentLlmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      if (promptText.includes('DeepCode serial slice fallback')) serialFallbackCalls += 1;
      if (promptText.includes('compact parent fallback step')) broadParentFallbackCalls += 1;
      assert(!promptText.includes('Prompt envelope size summary'), 'reclaimed node parent checkpoint does not reuse broad repair context');
      return jsonLlmResponse(singleTargetWriteProposal('generic-two.txt', `reclaimed-${caseName}`));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-accepted-plan-subagents-fallback-${caseName}`,
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 2, `${caseName}: sub-agent path attempts both independent slices once`);
  assertEqual(parentLlmCalls >= 1, true, `${caseName}: failed node is reclaimed by parent linear checkpoint`);
  assertEqual(serialFallbackCalls, 1, `${caseName}: failed node uses one compact serial fallback checkpoint`);
  assertEqual(broadParentFallbackCalls, 0, `${caseName}: failed node does not use broad parent fallback`);
  assertEqual(proposalSubmits, 2, `${caseName}: successful draft and reclaimed node each reach Kernel PlanReview once`);
  assertEqual(actionBatchSubmits, 2, `${caseName}: successful draft and reclaimed node each reach Kernel execution once`);
  assertEqual(result.events.some((event) => event.kind === 'error'), false, `${caseName}: branch failure does not become a terminal Session error event`);
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_branch.failed' &&
      (delta as any).status === 'failed'
    ),
    true,
    `${caseName}: failed branch is projected as a branch-scoped stage`
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_node.reclaimed' &&
      (delta as any).payload?.reason
    ),
    true,
    `${caseName}: failed branch is reclaimed with diagnostics`
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_serial_fallback.completed'
    ),
    true,
    `${caseName}: failed branch reaches compact serial fallback`
  );
  const actionBundle = submittedPlans[0]?.payload?.actionBundle;
  const submittedActionCount = submittedPlans.reduce((count, plan) =>
    count + (Array.isArray(plan?.payload?.actionBundle?.actions) ? plan.payload.actionBundle.actions.length : 0), 0);
  assertEqual(Array.isArray(actionBundle?.actions) && actionBundle.actions.length, 1, `${caseName}: first Parent submission contains the compact fallback action`);
  assertEqual(submittedActionCount >= 1, true, `${caseName}: reclaimed node produces executable Parent action(s)`);
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsRepairInvalidParentFallback(): Promise<void> {
  await runSubAgentInvalidParentFallbackRepairSmoke('serial-invalid');
}

async function runSubAgentInvalidParentFallbackRepairSmoke(
  caseName: string
): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent(`session-accepted-plan-subagents-fallback-repair-${caseName}`, `run-accepted-plan-subagents-fallback-repair-${caseName}`)];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: `session-accepted-plan-subagents-fallback-repair-${caseName}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let serialFallbackCalls = 0;
  let broadParentFallbackCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-repaired-one', output: { path: 'generic-one.txt' } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: 'work-unit-repaired-two', output: { path: 'generic-two.txt' } },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
        if (targetPath === 'generic-one.txt' || targetPath === 'generic-two.txt') {
          return jsonLlmResponse(genericDiagnosticProposal(`generic branch diagnostic ${caseName}`));
        }
        throw new Error(`unexpected sub-agent target in fallback repair smoke: ${targetPath}`);
      }
      parentLlmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      if (promptText.includes('DeepCode serial slice fallback')) serialFallbackCalls += 1;
      if (promptText.includes('compact parent fallback step')) broadParentFallbackCalls += 1;
      assert(promptText.includes('DeepCode serial slice fallback'), `${caseName}: serial fallback explains the retry contract`);
      assert(!promptText.includes('Prompt envelope size summary'), `${caseName}: serial fallback stays compact`);
      return jsonLlmResponse(deleteActionBundleProposal('generic-folder/'));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-accepted-plan-subagents-fallback-repair-${caseName}`,
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 2, `${caseName}: sub-agent path attempts both independent slices once`);
  assertEqual(parentLlmCalls, 1, `${caseName}: invalid fallback is attempted once`);
  assertEqual(serialFallbackCalls, 1, `${caseName}: invalid fallback uses serial slice path`);
  assertEqual(broadParentFallbackCalls, 0, `${caseName}: invalid fallback does not use broad parent fallback`);
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_serial_fallback.failed'
    ),
    true,
    `${caseName}: invalid serial fallback is projected as failed`
  );
  assertEqual(proposalSubmits, 0, `${caseName}: invalid serial fallback does not reach Kernel PlanReview`);
  assertEqual(actionBatchSubmits, 0, `${caseName}: invalid serial fallback does not reach Kernel execution`);
  assertEqual(result.events.some((event) => event.kind === 'error'), false, `${caseName}: invalid serial fallback is handled as diagnostic`);
  assert(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.diagnostic === true &&
      String((event.payload as any)?.content ?? (event.payload as any)?.summary ?? '').includes('serial')
    ),
    `${caseName}: invalid serial fallback produces a terminal diagnostic with the real reason`
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsTreatLegacyDependenciesAsSoftOrder(): Promise<void> {
  const events = [multiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-soft', 'run-accepted-plan-subagents-soft')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-soft',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (targetPath === 'generic-one.txt') return jsonLlmResponse(singleTargetModuleDraft('generic-one.txt', 'soft-one'));
      if (targetPath === 'generic-two.txt') return jsonLlmResponse(singleTargetModuleDraft('generic-two.txt', 'soft-two'));
      throw new Error('legacy soft-order smoke expected sliced provider calls');
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + llmCalls + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-soft',
    targetId: 'impl-generic-multi',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(llmCalls, 2, 'legacy implementationPlan dependencies are treated as soft order for sub-agent draft generation');
  assertEqual(proposalSubmits, 1, 'soft-order sub-agent fragments merge into one Kernel PlanReview submission');
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_plan.created'
    ),
    true,
    'soft-order sub-agent path emits subagent_plan.created'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_branch.draft_ready' &&
      (delta as any).status === 'draftReady'
    ),
    true,
    'soft-order sub-agent path emits branch draft-ready facts'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSkipSingleModule(): Promise<void> {
  const events = [singleModuleAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-single-module', 'run-accepted-plan-subagents-single-module')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-single-module',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'work_unit.completed', runId: 'run-generic', sessionId: session.id, workUnitId: `work-unit-single-module-${actionBatchSubmits}`, output: { path: actionBatchSubmits === 1 ? 'generic-module/header.txt' : 'generic-module/source.txt' } },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
        throw new Error('single module tasks must stay on the parent linear path');
      }
      parentLlmCalls += 1;
      return jsonLlmResponse(
        singleTargetWriteProposal(
          parentLlmCalls === 1 ? 'generic-module/header.txt' : 'generic-module/source.txt',
          `single-module-${parentLlmCalls}`
        )
      );
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + actionBatchSubmits + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-single-module',
    targetId: 'impl-generic-single-module',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 0, 'single module accepted plan does not start sub-agent branches');
  assert(parentLlmCalls >= 1, 'single module accepted plan continues through the parent provider');
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_skipped'
    ),
    true,
    'single module plan emits a sub-agent skip instead of dispatching branches'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSkipHardDependency(): Promise<void> {
  const events = [hardDependencyAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-hard', 'run-accepted-plan-subagents-hard')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-hard',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
      } else {
        parentLlmCalls += 1;
      }
      return jsonLlmResponse(singleTargetWriteProposal('generic-one/output.txt', 'hard-parent'));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-hard',
    targetId: 'impl-generic-hard',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 0, 'hard dependency blocks sub-agent parallel draft calls');
  assert(parentLlmCalls >= 1, 'hard dependency fallback continues through the parent provider');
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_skipped' &&
      (delta as any).payload?.reason === 'flow_graph_blocked'
    ),
    true,
    'hard dependency chain emits explicit DAG ready-width skip reason'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesDeleteAction(): Promise<void> {
  const events = [deleteAcceptedImplementationPlanCardEvent('session-accepted-plan-delete', 'run-accepted-plan-delete')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const transcripts: TranscriptEntry[] = [];
  let submittedBatch: Record<string, any> | undefined;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        submittedBatch = command.batch;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-delete', actionId: 'delete-generic-obsolete', status: 'queued', writeSet: ['generic-obsolete.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-delete',
              output: { path: 'generic-obsolete.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    appendTranscript: async (_sessionId, entry): Promise<void> => {
      transcripts.push(entry);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(deleteActionBundleProposal('generic-obsolete.txt')),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'delete-only accepted implementationPlan batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'delete-only accepted implementationPlan batch is auto-executed without codeBlocks');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'in-scope delete action does not become a user intervention');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'delete action does not create a second confirmable plan card');
  const deleteAction = submittedBatch?.actionBundle?.actions?.[0];
  assertEqual(deleteAction?.capability, 'fs.delete', 'submitted delete batch keeps fs.delete capability');
  assertEqual(deleteAction?.kind, 'delete', 'submitted delete batch keeps delete kind');
  assertEqual(deleteAction?.targetPath, 'generic-obsolete.txt', 'submitted delete batch keeps concrete targetPath');
  assertEqual(deleteAction?.resourceScope?.[0], 'generic-obsolete.txt', 'submitted delete batch normalizes resourceScope to the concrete file');
  const preflight = transcripts.find((entry) => {
    const record = entry as Record<string, any>;
    return record.kind === 'provider_trace' &&
      record.payload?.stage === 'accepted_plan.action_batch_preflight';
  });
  assert(Boolean(preflight), 'delete preflight trace is archived before Kernel actionBatchSubmit');
}

async function assertSessionDriverLoopAcceptedImplementationRejectsDeleteRootTarget(): Promise<void> {
  const events = [deleteAcceptedImplementationPlanCardEvent('session-accepted-plan-delete-root', 'run-accepted-plan-delete-root')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete-root',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'proposalSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(deleteActionBundleProposal('.')),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete-root',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 0, 'delete root target is rejected before Kernel actionBatchSubmit');
  assert(
    result.events.some((event) =>
      String((event.payload as any)?.content ?? (event.payload as any)?.summary ?? '').includes('fs.delete target cannot be empty or the workspace root')
    ),
    'delete root rejection explains that the target cannot be the workspace root'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanClassifiesDeleteCompileMismatch(): Promise<void> {
  const events = [deleteAcceptedImplementationPlanCardEvent('session-accepted-plan-delete-mismatch', 'run-accepted-plan-delete-mismatch')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete-mismatch',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  let reviewFactsGet = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-delete-mismatch', actionId: 'delete-generic-obsolete', status: 'queued', writeSet: ['generic-obsolete.txt'] },
            },
            {
              kind: 'work_unit.started',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-delete-mismatch',
            },
            {
              kind: 'work_unit.failed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-delete-mismatch',
              error: { code: 'invalid_command', message: 'invalid command: fs.write target path is empty' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsGet += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(deleteActionBundleProposal('generic-obsolete.txt')),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + reviewFactsGet + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete-mismatch',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 1, 'delete compile mismatch still comes from one Kernel actionBatchSubmit');
  assertEqual(reviewFactsGet, 0, 'delete compile mismatch stops before terminal review facts');
  const failure = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assertEqual((failure?.payload as any)?.failures?.[0]?.code, 'kernel_delete_compile_mismatch', 'delete write-path error is classified as Kernel delete compile mismatch');
  assertEqual(
    String((failure?.payload as any)?.summary ?? '').includes('fs.write target path is empty'),
    true,
    'delete compile mismatch keeps the original Kernel error message'
  );
  const projectedFailure = result.events.find((event) =>
    event.kind === 'error' &&
    (event.payload as any)?.kernelEvent?.kind === 'work_unit.failed'
  );
  assertEqual(
    JSON.stringify((projectedFailure?.payload as any)?.activity?.targets ?? []),
    JSON.stringify(['generic-obsolete.txt']),
    'work_unit.failed projection backfills targets from queued writeSet'
  );
  const projectedStarted = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.kernelEvent?.kind === 'work_unit.started'
  );
  assertEqual(
    JSON.stringify((projectedStarted?.payload as any)?.activity?.targets ?? []),
    JSON.stringify(['generic-obsolete.txt']),
    'work_unit.started projection backfills targets from queued writeSet'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanClassifiesPatchEvidenceMismatch(): Promise<void> {
  const token = randomSmokeToken('patch-mismatch');
  const targetPath = `${token}.txt`;
  const oldText = `old-${randomSmokeToken('text')}`;
  const replacementText = `new-${randomSmokeToken('text')}`;
  const events = [acceptedImplementationPlanCardEvent(`session-${token}`, `run-${token}`)];
  const planPayload = events[0].payload as any;
  planPayload.implementationPlan.tasks[0].target = [targetPath];
  planPayload.implementationPlan.tasks[0].capability = 'fs.patch';
  planPayload.implementationPlan.tasks[0].fileOperations = [{
    operation: 'patch',
    capability: 'fs.patch',
    targetPath,
    reason: 'Random accepted-plan patch mismatch smoke target.',
  }];
  const resourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: `entry-${token}`,
      status: 'resolved',
      readPolicy: 'explicit-manifest-readonly',
      sourceKind: 'file',
      contentKind: 'fileText',
      path: targetPath,
      content: oldText,
      promptContent: oldText,
      contentSummary: oldText,
      evidenceRefs: [`evidence-${token}`],
    }],
  };
  events.push({
    id: `event-${token}-resource-packet`,
    sessionId: `session-${token}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    payload: { toolName: 'kernel.resourceResolve', output: resourcePacket },
  });
  const session: AgentSession = {
    id: `session-${token}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  const patchProposal = (): Record<string, unknown> => ({
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Random patch batch',
      '',
      '## Summary',
      'Patch one accepted random target file using current ResourcePacket evidence.',
      '',
      '## Key Changes',
      '- Replace the exact old block with the generated replacement block.',
      '',
      '## Validation',
      '- Kernel records the patch result or a fail-closed mismatch.',
      '',
      '## Assumptions',
      '- The target path remains inside the accepted implementation plan.',
    ].join('\n'),
    codeBlocks: [{
      blockId: `block-${token}`,
      targetPath,
      contentLines: [replacementText],
    }],
    actionBundle: {
      version: '1',
      id: `bundle-${token}`,
      goal: 'Patch one random accepted target file.',
      actions: [{
        actionId: `patch-${token}`,
        toolId: 'fs.patch',
        args: {
          path: targetPath,
          replacementBlockId: `block-${token}`,
          patchSpec: { match: { kind: 'exactBlock', text: oldText } },
        },
        description: 'Patch the random accepted target.',
      }],
      validationExpectations: [{ id: `validation-${token}`, description: 'Kernel records the patch fact.' }],
      reviewExpectations: [{ id: `review-${token}`, description: 'User reviews the patch result.' }],
    },
    expectedValidation: 'Kernel records the patch fact.',
    reviewGuide: 'Review the patch result and Kernel facts.',
  });
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: `run-${token}`,
            sessionId: session.id,
            packet: {
              id: `packet-${token}`,
              requestId: command.requestId,
              items: [{
                requestItemId: `item-${token}`,
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: 'file',
                contentKind: 'fileText',
                path: targetPath,
                content: oldText,
                promptContent: oldText,
                contentSummary: oldText,
                evidenceRefs: [`evidence-${token}`],
              }],
            },
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: `run-${token}`, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: `run-${token}`,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            {
              kind: 'work_unit.queued',
              runId: `run-${token}`,
              sessionId: session.id,
              workUnit: { id: `work-unit-${token}`, actionId: `patch-${token}`, status: 'queued', writeSet: [targetPath] },
            },
            {
              kind: 'work_unit.failed',
              runId: `run-${token}`,
              sessionId: session.id,
              workUnitId: `work-unit-${token}`,
              actionId: `patch-${token}`,
              writeSet: [targetPath],
              error: { code: 'invalid_patch', message: 'patch match did not occur in target file' },
            },
            { kind: 'stage.changed', runId: `run-${token}`, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(patchProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-${token}`,
    targetId: 'impl-generic-auto',
    existingEvents: events,
    subAgentMode: 'off',
  });

  assertEqual(
    actionBatchSubmits,
    1,
    `patch mismatch is returned by one Kernel actionBatchSubmit; events=${events.map((event) => `${event.kind}:${String((event.payload as any)?.stage ?? (event.payload as any)?.reason ?? (event.payload as any)?.summary ?? (event.payload as any)?.content ?? (event.payload as any)?.message ?? '')}`).join('|')}`
  );
  const failure = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assertEqual(
    (failure?.payload as any)?.failures?.[0]?.code,
    'patch_stale_or_mismatched_evidence',
    'patch match miss is classified as stale or mismatched evidence'
  );
  assertEqual(
    String((failure?.payload as any)?.summary ?? '').includes('patch match did not occur'),
    true,
    'patch mismatch summary keeps the original Kernel error'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAllowsPlannedProcessExecPermissionGate(): Promise<void> {
  const events = [processExecAcceptedImplementationPlanCardEvent('session-accepted-plan-exec', 'run-accepted-plan-exec')];
  const session: AgentSession = {
    id: 'session-accepted-plan-exec',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [{
            kind: 'permission.requested',
            runId: 'run-generic',
            sessionId: session.id,
            permissionId: 'permission-exec-generic',
            request: {
              id: 'permission-exec-generic',
              capability: 'process.exec',
              summary: 'Run a generic validation command.',
            },
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(processExecProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-exec',
    targetId: 'impl-generic-exec',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'planned process.exec batch reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'planned process.exec batch reaches Kernel execution path');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'planned process.exec is not converted into a Session requirement');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'permission'
    ),
    true,
    'planned process.exec waits at Kernel PermissionGate'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanContinuesUntilTasksComplete(): Promise<void> {
  const events = [multiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-continue', 'run-accepted-plan-continue')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-continue',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const proposals = [
    relativeTargetWriteProposal('generic-one.txt', 'code-one', 'write-generic-one'),
    relativeTargetWriteProposal('generic-two.txt', 'code-two', 'write-generic-two'),
  ];
  let llmCalls = 0;
  let subAgentLlmCalls = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const actionId = action.id ?? action.actionId ?? `write-generic-${actionBatchSubmits}`;
        const path = action.targetPath ?? action.resourceScope?.[0] ?? `generic-${actionBatchSubmits}.txt`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: `work-unit-${actionBatchSubmits}`, actionId, status: 'queued', writeSet: [path] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: `work-unit-${actionBatchSubmits}`,
              output: { path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      if ((request.providerOptions?.deepcode as any)?.subAgent) {
        subAgentLlmCalls += 1;
        throw new Error('subAgentMode=off must not start sub-agent provider calls');
      }
      const proposal = proposals[Math.min(llmCalls, proposals.length - 1)];
      llmCalls += 1;
      return jsonLlmResponse(proposal);
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-continue',
    targetId: 'impl-generic-multi',
    existingEvents: events,
    subAgentMode: 'off',
  });

  assertEqual(llmCalls, 2, 'accepted implementationPlan automatically requests the second provider batch');
  assertEqual(subAgentLlmCalls, 0, 'subAgentMode=off never starts sub-agent provider calls');
  assertEqual(actionBatchSubmits, 2, 'accepted implementationPlan executes both in-scope batches');
  assertEqual(
    deltas.some((delta) =>
      String((delta as any).stage ?? '').startsWith('subagent_branch.') ||
      (delta as any).stage === 'subagent_plan.created' ||
      (delta as any).stage === 'subagent_dispatch.announced' ||
      String((delta as any).stage ?? '').startsWith('subagent_merge.')
    ),
    false,
    'subAgentMode=off does not emit sub-agent branch, dispatch, plan, or merge deltas'
  );
  assertEqual(result.events.filter((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview').length, 1, 'accepted implementationPlan produces only one terminal review');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.includes('task-generic-two')
    ),
    true,
    'first accepted-plan checkpoint keeps the remaining task queued'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanReadsGeneratedArtifactEvidence(): Promise<void> {
  const events = [generatedArtifactAcceptedImplementationPlanCardEvent('session-generated-artifact-evidence', 'run-generated-artifact-evidence')];
  const session: AgentSession = {
    id: 'session-generated-artifact-evidence',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const proposals = [
    singleTargetWriteProposal('generic-generated/input.txt', 'generated-input'),
    {
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generated-input',
        reason: 'Read the file generated by the previous accepted batch.',
        items: [{
          id: 'generated-input',
          kind: 'file',
          rootId: 'stale-root-id',
          path: 'generic-generated/input.txt',
          reason: 'Use the current run generated artifact as evidence for the next batch.',
        }],
      },
    },
    singleTargetWriteProposal('generic-generated/output.txt', 'generated-output'),
  ];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let resourceResolveCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'resourceResolve') {
        resourceResolveCalls += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const actionId = action.id ?? action.actionId ?? `write-generated-${actionBatchSubmits}`;
        const path = action.targetPath ?? action.resourceScope?.[0] ?? `generic-generated/${actionBatchSubmits}.txt`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: `work-unit-generated-${actionBatchSubmits}`, actionId, status: 'queued', writeSet: [path] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: `work-unit-generated-${actionBatchSubmits}`,
              actionId,
              output: { actionId, path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const proposal = proposals[Math.min(llmCalls, proposals.length - 1)];
      llmCalls += 1;
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + resourceResolveCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-generated-artifact-evidence',
    targetId: 'impl-generated-artifact',
    existingEvents: events,
    subAgentMode: 'off',
  });

  assertEqual(llmCalls, 3, 'provider resumes after generated artifact resourceRequest');
  assertEqual(actionBatchSubmits, 2, 'generated artifact evidence allows the dependent batch to execute');
  assertEqual(resourceResolveCalls, 0, 'generated artifact resourceRequest is satisfied without stale Kernel ResourceResolve');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'tool_result' &&
      (event.payload as any)?.toolName === 'kernel.resourceResolve' &&
      Array.isArray((event.payload as any)?.output?.items) &&
      (event.payload as any).output.items.some((item: any) =>
        item.path === 'generic-generated/input.txt' &&
        Array.isArray(item.evidenceRefs) &&
        item.evidenceRefs.includes('generatedArtifactEvidence') &&
        typeof item.promptContent === 'string' &&
        item.promptContent.includes('generated-input')
      )
    ),
    true,
    'generated file content is projected as run-local generated artifact evidence'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanResumesFromResourceCursor(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-resource-resume', 'run-accepted-plan-resource-resume')];
  const session: AgentSession = {
    id: 'session-accepted-plan-resource-resume',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const providerPrompts: string[] = [];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  let resourceResolveCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'resourceResolve') {
        resourceResolveCalls += 1;
        return fakeKernel(request);
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: {
                id: 'work-unit-resource-resume',
                actionId: 'write-generic-output',
                status: 'queued',
                writeSet: ['generic-output.txt'],
              },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-resource-resume',
              actionId: 'write-generic-output',
              output: { path: 'generic-output.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const userMessage = request.messages.find((message) => message.role === 'user')?.content ?? '';
      providerPrompts.push(userMessage);
      if (llmCalls === 1) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'resourceRequest',
          outputLanguage: 'en-US',
          resourceRequest: {
            version: '1',
            id: 'request-current-generic-output',
            reason: 'Read the current generic output evidence before writing.',
            items: [{
              id: 'current-generic-output',
              kind: 'file',
              path: 'generic-output.txt',
              reason: 'Use current file evidence for the accepted task.',
            }],
          },
        });
      }
      assert(userMessage.includes('Accepted-plan resource resume checkpoint'), 'second provider call uses compact resource resume checkpoint');
      assert(userMessage.includes('TaskExecutionCursor'), 'resource resume prompt includes the task cursor');
      assert(userMessage.includes('CurrentTaskGoal'), 'resource resume prompt includes the current task goal');
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + resourceResolveCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-resource-resume',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'root-generic-workspace',
      label: 'Generic workspace',
      displayPath: '/tmp/generic-workspace',
      absolutePath: '/tmp/generic-workspace',
      source: 'projectWorkingDirectory',
    },
    subAgentMode: 'off',
  });

  assertEqual(llmCalls, 2, 'accepted-plan resourceRequest resumes through one compact provider call');
  assertEqual(actionBatchSubmits, 1, 'compact resource resume actionBundle is submitted to Kernel');
  assertEqual(resourceResolveCalls >= 1, true, 'resource resume resolves current evidence through Kernel ResourceResolve');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.resource_resume' &&
      typeof (event.payload as any)?.taskCursorId === 'string'
    ),
    true,
    'accepted-plan resource resume writes cursor projection'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.task_savepoint'
    ),
    true,
    'accepted-plan execution writes a task savepoint after the resumed batch'
  );
  assert(providerPrompts[0] && !providerPrompts[0].includes('Accepted-plan resource resume checkpoint'), 'first call remains the normal accepted-plan provider call');
}

async function assertSessionDriverLoopAcceptedImplementationPlanInheritsSubAgentOffSetting(): Promise<void> {
  const events = [
    independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-inherit-off', 'run-accepted-plan-inherit-off'),
    {
      id: 'agent-runtime-settings-inherit-off',
      sessionId: 'session-accepted-plan-inherit-off',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'workflow_stage' as const,
      payload: {
        stage: 'agent_runtime_settings',
        status: 'completed',
        runId: 'run-accepted-plan-inherit-off',
        subAgentMode: 'off',
        subAgentMaxParallel: 2,
        source: 'request',
      },
    },
  ];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-inherit-off',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const path = action.targetPath ?? action.resourceScope?.[0] ?? `generic-${actionBatchSubmits}.txt`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: `work-unit-inherit-${actionBatchSubmits}`,
              output: { path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      if ((request.providerOptions?.deepcode as any)?.subAgent) {
        subAgentLlmCalls += 1;
        throw new Error('inherited subAgentMode=off must not start sub-agent provider calls');
      }
      parentLlmCalls += 1;
      return jsonLlmResponse(multiWriteProposal());
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + actionBatchSubmits + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-inherit-off',
    targetId: 'impl-generic-independent',
    existingEvents: events,
  });

  assertEqual(parentLlmCalls, 1, 'inherited subAgentMode=off uses the parent provider path');
  assertEqual(subAgentLlmCalls, 0, 'inherited subAgentMode=off blocks sub-agent calls');
  assertEqual(actionBatchSubmits, 1, 'inherited subAgentMode=off submits the parent actionBundle without branch execution');
  assertEqual(
    events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'agent_runtime_settings' &&
      (event.payload as any)?.subAgentMode === 'off' &&
      (event.payload as any)?.source === 'runtimeSnapshot'
    ),
    true,
    'inherited off mode is recorded in the runtime settings snapshot'
  );
  assertEqual(
    deltas.some((delta) => String((delta as any).stage ?? '').startsWith('subagent_branch.')),
    false,
    'inherited subAgentMode=off emits no branch deltas'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanDoesNotInheritSubAgentAutoSetting(): Promise<void> {
  const events = [
    independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-ignore-auto', 'run-accepted-plan-ignore-auto'),
    {
      id: 'agent-runtime-settings-inherit-auto',
      sessionId: 'session-accepted-plan-ignore-auto',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'workflow_stage' as const,
      payload: {
        stage: 'agent_runtime_settings',
        status: 'completed',
        runId: 'run-accepted-plan-ignore-auto',
        subAgentMode: 'auto',
        subAgentMaxParallel: 2,
        source: 'request',
      },
    },
  ];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-ignore-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const path = action.targetPath ?? action.resourceScope?.[0] ?? `generic-${actionBatchSubmits}.txt`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: `work-unit-ignore-auto-${actionBatchSubmits}`,
              output: { path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      if ((request.providerOptions?.deepcode as any)?.subAgent) {
        subAgentLlmCalls += 1;
        throw new Error('historical subAgentMode=auto must not be inherited without an explicit current request mode');
      }
      parentLlmCalls += 1;
      return jsonLlmResponse(multiWriteProposal());
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + actionBatchSubmits + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-ignore-auto',
    targetId: 'impl-generic-independent',
    existingEvents: events,
  });

  assertEqual(parentLlmCalls, 1, 'omitted subAgentMode defaults to the parent provider path even after historical auto mode');
  assertEqual(subAgentLlmCalls, 0, 'historical subAgentMode=auto is not inherited into a new request');
  assertEqual(actionBatchSubmits, 1, 'default off mode still submits the parent actionBundle');
  assertEqual(
    events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'agent_runtime_settings' &&
      (event.payload as any)?.subAgentMode === 'off' &&
      (event.payload as any)?.source === 'default'
    ),
    true,
    'omitted current mode records a fail-closed off runtime settings snapshot'
  );
  assertEqual(
    deltas.some((delta) => String((delta as any).stage ?? '').startsWith('subagent_branch.')),
    false,
    'default off mode emits no branch deltas'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_skipped' &&
      (delta as any).payload?.reason === 'mode_off'
    ),
    true,
    'default off mode emits only the mode_off skip fact'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAllowsAbsoluteAttachmentChildTarget(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-absolute-child', root),
    acceptedImplementationPlanCardEvent('session-accepted-plan-absolute-child', 'run-accepted-plan-absolute-child'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-absolute-child',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}, root),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(absoluteTargetWriteProposal(`${root}/generic-output.txt`)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-absolute-child',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(actionBatchSubmits, 1, 'absolute child target under accepted attachment root is auto-executed');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'absolute child target does not trigger scope intervention');
}

async function assertSessionDriverLoopAcceptedImplementationRejectsAttachmentRootTarget(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-root-target', root),
    acceptedImplementationPlanCardEvent('session-accepted-plan-root-target', 'run-accepted-plan-root-target'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-root-target',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(absoluteTargetWriteProposal(root)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-root-target',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(actionBatchSubmits, 0, 'attachment root target is rejected before Kernel actionBatchSubmit');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'attachment root target becomes one scope intervention');
  assert(
    result.events.some((event) => String((event.payload as any)?.summary ?? '').includes('不是可写入文件')),
    'attachment root target intervention explains that the target is a directory root'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanProjectsWorkUnitFailureReason(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-failure', 'run-accepted-plan-failure')];
  const session: AgentSession = {
    id: 'session-accepted-plan-failure',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        return {
          ok: true,
          events: [
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.started',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'running', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.failed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              writeSet: ['generic-output.txt'],
              error: { code: 'invalid_path', message: 'fs.write target is outside workspace binding' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-failure',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  const errorMessage = result.events
    .filter((event) => event.kind === 'error')
    .map((event) => String((event.payload as any)?.message ?? ''))
    .join('\n');
  assert(errorMessage.includes('work-unit-generic'), 'work_unit.failed projection includes the work unit id');
  assert(errorMessage.includes('fs.write target is outside workspace binding'), 'work_unit.failed projection includes the Kernel error message');
  assert(!errorMessage.includes('Kernel rejected the proposal'), 'work_unit.failed projection is not mislabeled as proposal rejection');
  assertEqual(reviewFactsRequests, 0, 'work_unit.failed stops accepted-plan flow before reviewFactsGet');
  assertEqual(result.events.some((event) => event.kind === 'review_summary'), false, 'work_unit.failed does not create terminal review');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'failed' &&
      (event.payload as any)?.reason === 'work_unit_failed'
    ),
    true,
    'work_unit.failed appends explicit failed session lifecycle'
  );
  const failureCheckpoint = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assert(Boolean(failureCheckpoint), 'work_unit.failed records an accepted-plan failure checkpoint');
  assert(
    JSON.stringify((failureCheckpoint?.payload as any)?.failures ?? []).includes('generic-output.txt'),
    'failure checkpoint retains writeSet details'
  );
}

async function assertSessionDriverLoopAcceptedImplementationRejectsOutOfScopeBatch(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-oos', 'run-accepted-plan-oos')];
  const session: AgentSession = {
    id: 'session-accepted-plan-oos',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let llmCalls = 0;
  const outOfScopeProposal = genericWriteProposal(false);
  (outOfScopeProposal.codeBlocks as any[])[0].targetPath = 'outside-output.txt';
  (outOfScopeProposal.actionBundle as any).actions[0].args = { path: 'outside-output.txt', sourceBlockId: 'generic-block' };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: command.runId, sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: command.runId,
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: command.runId, sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: command.runId,
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              output: { path: 'generic-output.txt' },
            },
            { kind: 'stage.changed', runId: command.runId, sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(llmCalls <= 2 ? outOfScopeProposal : genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-oos',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 0, 'out-of-scope accepted implementationPlan batch does not reach Kernel PlanReview');
  assertEqual(actionBatchSubmits, 0, 'out-of-scope accepted implementationPlan batch is not executed');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'out-of-scope batch does not create another plan card');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'out-of-scope batch becomes one user intervention request');
  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as any;
  assertEqual(confirmationPayload?.interactionOverlay, true, 'accepted-plan scope intervention is marked as an overlay');
  assertEqual(confirmationPayload?.parentPhase, 'executing_accepted_plan', 'accepted-plan scope intervention records the parent phase');
  assertEqual(confirmationPayload?.decisionRequest?.decisionScope, 'acceptedPlanBatchOutOfScope', 'accepted-plan scope decision is identifiable');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'requirement' &&
      (event.payload as any)?.interactionOverlay === true
    ),
    true,
    'out-of-scope batch records waiting requirement overlay session state'
  );

  const resumed = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'accept',
    runId: confirmationPayload?.runId,
    targetId: confirmationPayload?.requirementId,
    guidance: '- id: regenerate-in-scope',
    existingEvents: result.events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 1, 'accepted-plan scope decision resumes provider checkpoint and submits repaired batch');
  assertEqual(actionBatchSubmits, 1, 'accepted-plan scope decision continues to actionBatchSubmit after in-scope regeneration');
  assertEqual(
    resumed.events.some((event) =>
      event.kind === 'requirement_decision' &&
      (event.payload as any)?.interactionOverlay === true &&
      (event.payload as any)?.parentPhase === 'executing_accepted_plan'
    ),
    true,
    'accepted-plan scope decision remains attached to the parent execution overlay'
  );
}

async function assertSessionDriverLoopAcceptedPlanPatchRequestsSearchEvidence(): Promise<void> {
  const planEvent = acceptedImplementationPlanCardEvent('session-accepted-plan-patch-evidence', 'run-accepted-plan-patch-evidence');
  const planPayload = planEvent.payload as any;
  planPayload.planId = 'impl-generic-patch';
  planPayload.implementationPlan.id = 'impl-generic-patch';
  planPayload.implementationPlan.tasks = [{
    taskId: 'task-generic-patch',
    title: 'Patch generic file',
    target: ['generic-patch.txt'],
    scope: 'Patch one generic file with exact ResourcePacket evidence.',
    dependencies: [],
    capability: 'fs.write',
    acceptanceCriteria: ['Kernel records the generic patch work unit fact.'],
    failureCriteria: ['Stop if the patch lacks current exact-block evidence.'],
  }];
  const root = '/workspace/generic-project';
  const events = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-patch-evidence', root),
    planEvent,
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-patch-evidence',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let resourceSearchRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const entry = command.request?.manifest?.entries?.[0] ?? {};
        if (entry.kind === 'search') resourceSearchRequests += 1;
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            packet: {
              id: `packet-generic-${resourceSearchRequests}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'search-item',
                manifestEntryId: entry.id ?? 'search-entry',
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                resolvedKind: entry.kind,
                contentKind: entry.kind === 'search' ? 'searchResults' : 'directoryTree',
                path: entry.kind === 'search' ? 'generic-patch.txt' : entry.resourceRef,
                absolutePath: entry.resourceRef,
                query: entry.query,
                matches: entry.kind === 'search'
                  ? [{ path: 'generic-patch.txt', line: 1, preview: 'old generic line' }]
                  : undefined,
                returnedMatches: entry.kind === 'search' ? 1 : undefined,
                promptContent: entry.kind === 'search'
                  ? JSON.stringify({ matches: [{ path: 'generic-patch.txt', line: 1, preview: 'old generic line' }] })
                  : undefined,
                nodes: entry.kind === 'search' ? undefined : [{ type: 'file', path: 'generic-patch.txt' }],
                evidenceRefs: ['evidence-generic-patch'],
              }],
            },
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic-patch', actionId: 'patch-generic-output', status: 'queued', writeSet: ['generic-patch.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic-patch',
              output: { path: 'generic-patch.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) return jsonLlmResponse(genericPatchProposal());
      if (llmCalls === 2) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'resourceRequest',
          outputLanguage: 'en-US',
          resourceRequest: {
            version: '1',
            id: 'need-generic-patch-anchor',
            reason: 'Need current exact-block evidence before patching.',
            items: [{
              id: 'search-generic-patch-anchor',
              kind: 'search',
              query: 'old generic line',
              include: ['generic-patch.txt'],
              contextLines: 1,
              maxResults: 5,
              reason: 'Find the generic exact patch anchor.',
            }],
          },
        });
      }
      return jsonLlmResponse(genericPatchProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + resourceSearchRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-patch-evidence',
    targetId: 'impl-generic-patch',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
    interventionLevel: 'medium',
  });

  assertEqual(resourceSearchRequests, 1, 'patch without evidence is repaired through one search ResourceResolve');
  assertEqual(proposalSubmits, 1, 'patch action reaches Kernel PlanReview only after ResourcePacket evidence exists');
  assertEqual(actionBatchSubmits, 1, 'patch action executes after exact-block evidence is available');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'search ResourcePacket is committed before patch execution');
}

async function assertSessionDriverLoopReviewAcceptAutoGeneratesNextPlan(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-accept-generic',
    sessionId: 'session-review-accept',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-accept',
      reviewId: 'review-accept-generic',
      sourcePlanId: 'plan-accept-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'fs.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-accept',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-accept', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-accept',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-accept',
    existingEvents: events,
  });

  const acceptedReview = result.events.find((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted');
  if (!acceptedReview) throw new Error('review accept records an accepted review event');
  const acceptedPayload = acceptedReview.payload as any;
  assertEqual(acceptedPayload.continuationRequested, false, 'review accept closes the current review before continuation planning');
  assert(String(acceptedPayload.content ?? '').includes('确认后的合规 actionBundle 会自动提交 Kernel 执行'), 'accepted review explains confirmed continuation batches auto-submit to Kernel');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'completed' &&
      (event.payload as any)?.reason === 'review'
    ),
    false,
    'auto continuation review accept does not mark the current run completed before continuation planning'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'default review continuation mode generates the next plan');
  assertEqual(submittedPlans.length, 1, 'default review continuation mode submits the next actionBundle for Kernel PlanReview');
  assertEqual(llmRequests.length, 1, 'default review continuation mode calls the provider once for a new plan');
}

async function assertSessionDriverLoopReviewAcceptWithoutContinuationCompletesRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-terminal-generic',
    sessionId: 'session-review-terminal',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-terminal',
      reviewId: 'review-terminal-generic',
      sourcePlanId: 'plan-terminal-generic',
      content: '## Review\n\nThe generic batch completed.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-terminal',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-terminal', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-terminal',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-terminal',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'terminal review accept records an accepted review event');
  const completedState = result.events.find((event) =>
    event.kind === 'session_run_state' &&
    (event.payload as any)?.status === 'completed' &&
    (event.payload as any)?.reason === 'review'
  );
  assert(Boolean(completedState), 'terminal review accept records an explicit completed session state');
  const completedPayload = completedState?.payload as any;
  assertEqual(completedPayload.phase, 'completed', 'terminal review completed state carries completed phase');
  assertEqual(completedPayload.decisionKind, 'review', 'terminal review completed state keeps review owner kind');
  assertEqual(completedPayload.targetId, 'review-terminal-generic', 'terminal review completed state keeps review owner target');
  assertEqual(submittedPlans.length, 0, 'terminal review accept does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'terminal review accept does not call the provider');
}

async function assertSessionDriverLoopReviewAcceptOffStopsAtCurrentBatch(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-accept-off-generic',
    sessionId: 'session-review-accept-off',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-accept-off',
      reviewId: 'review-accept-off-generic',
      sourcePlanId: 'plan-accept-off-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'fs.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-accept-off',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-accept-off', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-accept-off',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-accept-off',
    existingEvents: events,
    reviewContinuationMode: 'off',
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'review accept records an accepted review event');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'completed' &&
      (event.payload as any)?.reason === 'review'
    ),
    true,
    'off review continuation mode records an explicit completed session state'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'off review continuation mode does not generate a continuation plan');
  assertEqual(submittedPlans.length, 0, 'off review continuation mode does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'off review continuation mode does not call the provider');
}

async function assertSessionDriverLoopRequirementRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'requirement-waiting-generic',
    sessionId: 'session-requirement-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: 'Requirement confirmation',
      summary: 'Confirm a generic requirement.',
      content: 'Confirm how to proceed with a generic request.',
      originalRequest: 'Create a generic workspace change.',
      runId: 'run-requirement-reject',
      requirementId: 'requirement-generic-reject',
      status: 'waitingUserConfirmation',
      confirmable: true,
    },
  }];
  const session: AgentSession = {
    id: 'session-requirement-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'reject',
    runId: 'run-requirement-reject',
    targetId: 'requirement-generic-reject',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'requirement_decision' && (event.payload as any)?.status === 'rejected'), true, 'requirement reject records a rejected decision');
  assertCancelledRunState(result.events, 'requirement', 'run-requirement-reject', 'requirement-generic-reject');
  assertEqual(llmCalls, 0, 'requirement reject does not call the provider');
}

async function assertSessionDriverLoopRejectedDecisionCancelsRun(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-plan-reject', 'run-plan-reject')];
  const session: AgentSession = {
    id: 'session-plan-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'reject',
    runId: 'run-plan-reject',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'plan_review' && (event.payload as any)?.status === 'rejected'), true, 'plan reject records a rejected plan decision');
  assertCancelledRunState(result.events, 'plan_review', 'run-plan-reject', 'impl-generic-auto');
  assertEqual(actionBatchSubmits, 0, 'plan reject does not submit an action batch');
}

async function assertSessionDriverLoopReviewRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-reject-generic',
    sessionId: 'session-review-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-reject',
      reviewId: 'review-generic-reject',
      sourcePlanId: 'plan-generic-reject',
      content: '## Review\n\nA generic batch is ready.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{ id: 'next-generic', title: 'A generic follow-up task.' }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let userDecisionSubmits = 0;
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        assertEqual(command.decision?.payload?.decision, 'reject', 'review ignore sends a reject user decision to Kernel audit');
        assertEqual(command.decision?.payload?.continuationRequested, false, 'review reject does not request continuation');
        assertEqual(command.decision?.payload?.revisionRequested, false, 'review reject does not request revision');
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'review',
    decision: 'reject',
    runId: 'run-review-reject',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'rejected'), true, 'review reject records a rejected review decision');
  assertCancelledRunState(result.events, 'review', 'run-review-reject', 'review-generic-reject');
  assertEqual(userDecisionSubmits, 1, 'review reject records exactly one Kernel user decision');
  assertEqual(llmCalls, 0, 'review reject does not call the provider for revision or continuation');
}

async function assertSessionDriverLoopPermissionRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'permission-request-generic',
    sessionId: 'session-permission-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'permission_request',
    payload: {
      id: 'permission-generic-reject',
      runId: 'run-permission-reject',
      planId: 'plan-permission-reject',
      status: 'pending',
      summary: 'A generic permission request is pending.',
    },
  }];
  const session: AgentSession = {
    id: 'session-permission-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let permissionResolves = 0;
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'permissionResolve') {
        permissionResolves += 1;
        assertEqual(command.decision, 'reject', 'permission ignore sends a reject decision to Kernel');
        return {
          ok: true,
          events: [{
            kind: 'permission.resolved',
            permissionId: 'permission-generic-reject',
            runId: 'run-permission-reject',
            sessionId: session.id,
            decision: 'reject',
          }],
        };
      }
      if (command.kind === 'reviewFactsGet') reviewFactsRequests += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + permissionResolves + reviewFactsRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'permission',
    decision: 'reject',
    runId: 'run-permission-reject',
    targetId: 'permission-generic-reject',
    existingEvents: events,
  });

  assertCancelledRunState(result.events, 'permission', 'run-permission-reject', 'permission-generic-reject');
  assertEqual(permissionResolves, 1, 'permission reject resolves exactly one Kernel permission request');
  assertEqual(reviewFactsRequests, 0, 'permission reject does not continue into review facts');
}

async function assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept(): Promise<void> {
  const events: AgentEvent[] = [
    {
      id: 'old-requirement-generic',
      sessionId: 'session-stale-interaction',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: {
        title: 'Requirement confirmation',
        summary: 'Confirm an earlier generic requirement.',
        content: 'Create a generic workspace change.',
        originalRequest: 'Create a generic workspace change.',
        runId: 'run-stale-requirement',
        requirementId: 'requirement-stale-generic',
        status: 'waitingUserConfirmation',
        confirmable: true,
      },
    },
    {
      id: 'new-review-generic',
      sessionId: 'session-stale-interaction',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'review_summary',
      payload: {
        status: 'waitingUserReview',
        runId: 'run-current-review',
        reviewId: 'review-current-generic',
        sourcePlanId: 'plan-current-generic',
        content: '## Review\n\nThe current generic batch is ready for review.',
        userPlan: '# Plan\n\n## Summary\nReview the current generic batch.',
        facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
        continuations: [{
          id: 'next-generic-batch',
          title: 'Record a later generic continuation.',
          capability: 'fs.write',
          kind: 'write',
          resourceScope: ['generic-follow-up.txt'],
        }],
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-stale-interaction',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-stale-interaction', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const accepted = await loop.resolveDecision({
    sessionId: 'session-stale-interaction',
    kind: 'review',
    decision: 'accept',
    runId: 'run-current-review',
    existingEvents: events,
    reviewContinuationMode: 'off',
  });
  assertEqual(accepted.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'current review is accepted');

  const stale = await loop.resolveDecision({
    sessionId: 'session-stale-interaction',
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-stale-requirement',
    targetId: 'requirement-stale-generic',
    existingEvents: accepted.events,
  });

  assertEqual(stale.events.some((event) => event.kind === 'trace/requirement_decision_noop'), true, 'stale requirement decision is recorded as noop');
  assertEqual(llmRequests.length, 0, 'stale requirement decision does not call the provider');
  assertEqual(submittedPlans.length, 0, 'stale requirement decision does not submit a plan');
}

async function assertSessionDriverLoopNativeReadToolStreamsThroughResourceResolve(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-native-read',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native read smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (streamRequests.length === 1) {
        const chunks: LlmChatResult['chunks'] = [
          {
            type: 'tool_call',
            index: 0,
            callId: 'call-generic-read',
            toolCallDelta: { id: 'call-generic-read', index: 0, name: 'fs.read', argumentsDelta: '{"path":"' },
          },
          {
            type: 'tool_call',
            index: 0,
            callId: 'call-generic-read',
            toolCallDelta: { index: 0, argumentsDelta: 'generic-input.txt"}' },
          },
          { type: 'done' },
        ];
        for (const chunk of chunks.slice(0, 2)) {
          await onEvent({ type: 'provider_tool_call_delta', chunk });
        }
        return {
          ok: true,
          data: {
            chunks,
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call-generic-read',
                name: 'fs.read',
                arguments: { path: 'generic-input.txt' },
              }],
            },
          },
        };
      }
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      assert(Boolean(toolMessage?.content.includes('resolved generic content')), 'provider resume receives Kernel resource tool result');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: {
          format: 'markdown',
          content: 'The generic read result was incorporated after Kernel ResourceResolve.',
        },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read',
    content: 'Use a native read tool only if resource context is needed.',
    attachments: [{ kind: 'directory', path: '.', absolutePath: '/tmp/generic-workspace', source: 'userSelected', scope: 'session' }],
  });

  assertEqual(streamRequests.length, 2, 'native read tool triggers provider resume after Kernel result');
  assertEqual(resourceResolveManifests.length >= 1, true, 'native read tool is routed through Kernel ResourceResolve');
  assertEqual(
    resourceResolveManifests.some((manifest) =>
      (manifest.entries ?? []).some((entry: Record<string, unknown>) => String(entry.resourceRef ?? '').endsWith('generic-input.txt'))
    ),
    true,
    'native read manifest carries the requested resource'
  );
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'Kernel ResourcePacket is committed as tool_result');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'), true, 'provider resume produces one final answer');
  assertEqual(deltas.some((delta) => (delta as any).type === 'tool_call_delta'), true, 'streaming native tool deltas are exposed as active projection deltas');
  assertEqual(
    deltas.some((delta) => (delta as any).activity?.kind === 'toolExecution'),
    true,
    'active projection deltas carry public conversation activity metadata'
  );
}

async function assertSessionDriverLoopNativeReadToolLoopHasNoFourRoundLimit(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-native-read-unbounded',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native read unbounded smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      const round = streamRequests.length;
      if (round <= 6) {
        const path = `generic-input-${round}.txt`;
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId: `call-generic-read-${round}`,
          toolCallDelta: {
            id: `call-generic-read-${round}`,
            index: 0,
            name: 'fs.read',
            argumentsDelta: JSON.stringify({ path }),
          },
        };
        await onEvent({ type: 'provider_tool_call_delta', chunk });
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: `call-generic-read-${round}`,
                name: 'fs.read',
                arguments: { path },
              }],
            },
          },
        };
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      assertEqual(toolMessages.length >= 6, true, 'provider resume receives all prior Kernel resource tool results');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'zh-CN',
        answer: {
          format: 'markdown',
          content: '已在多轮只读资源读取后收口。',
        },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-unbounded',
    content: '分析这个项目，需要连续读取多个只读文件后再回答。',
    attachments: [{ kind: 'directory', path: '.', absolutePath: '/tmp/generic-workspace', source: 'userSelected', scope: 'session' }],
  });

  assertEqual(streamRequests.length, 7, 'native read tool loop continues past the former four-resume limit and then converges');
  assertEqual(resourceResolveManifests.length >= 6, true, 'each native read tool request is routed through Kernel ResourceResolve');
  assertEqual(result.events.some((event) => event.id.includes('native_tool_loop_exhausted')), false, 'native read tool loop does not emit the former exhaustion diagnostic');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'session' &&
      String((event.payload as any)?.content ?? '').includes('原生工具')
    ),
    false,
    'native tool progress metadata does not become Session-authored conversation narration'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).summary === 'native_tool_checkpoint' &&
      Number((delta as any).payload?.nativeToolRound ?? -1) >= 4
    ),
    true,
    'high-round native tool checkpoints are exposed as task/debug projection metadata'
  );
  assertEqual(deltas.some((delta) => (delta as any).type === 'tool_call_delta'), true, 'high-round native tool deltas remain visible');
}

async function assertSessionDriverLoopNativeReadToolDuplicateLoopRepairsToProposal(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: 'session-native-read-duplicate',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native duplicate read smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (request.tools?.length) {
        const callId = `call-duplicate-read-${streamRequests.length}`;
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId,
          toolCallDelta: {
            id: callId,
            index: 0,
            name: 'fs.read',
            argumentsDelta: JSON.stringify({ path: 'generic-duplicate.txt' }),
          },
        };
        await onEvent({ type: 'provider_tool_call_delta', chunk });
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: streamRequests.length > 1 ? 'I already have the file and should answer now.' : '',
              toolCalls: [{
                id: callId,
                name: 'fs.read',
                arguments: { path: 'generic-duplicate.txt' },
              }],
            },
          },
        };
      }
      assertEqual(request.tools?.length ?? 0, 0, 'duplicate read repair disables provider-native tools');
      const duplicateRepairPrompt = request.messages.some((message) =>
        message.role === 'user' && String(message.content).includes('Duplicate native read targets')
      );
      if (!duplicateRepairPrompt) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: {
            format: 'markdown',
            content: 'The repeated read was stopped and the existing resource facts were used.',
          },
        });
      }
      assert(duplicateRepairPrompt, 'duplicate read repair prompt includes duplicate target facts');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: {
          format: 'markdown',
          content: 'The repeated read was stopped and the existing resource facts were used.',
        },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-duplicate',
    content: 'Read a generic file if needed, then answer.',
    attachments: [{ kind: 'directory', path: '.', absolutePath: '/tmp/generic-workspace', source: 'userSelected', scope: 'session' }],
  });

  const nativeResourceResolveManifests = resourceResolveManifests.filter((manifest) =>
    Array.isArray(manifest.entries) && manifest.entries.some((entry: any) => String(entry?.id ?? '').startsWith('native-'))
  );
  assertEqual(nativeResourceResolveManifests.length, 1, 'duplicate native read does not repeatedly call Kernel ResourceResolve');
  assertEqual(streamRequests.length, 4, 'duplicate native read gets one cached resume and one no-tool repair call');
  assertEqual(
    result.events.some((event) => event.kind === 'assistant_msg' && String((event.payload as any)?.content ?? '').includes('repeated read was stopped')),
    true,
    'duplicate native read repair returns a final answer'
  );
}

async function assertSessionDriverLoopNativeReadToolDuplicateProposalWinsOverToolCall(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: 'session-native-read-duplicate-proposal',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native duplicate proposal smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      const callId = `call-duplicate-proposal-${streamRequests.length}`;
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'tool_call',
        index: 0,
        callId,
        toolCallDelta: {
          id: callId,
          index: 0,
          name: 'fs.read',
          argumentsDelta: JSON.stringify({ path: 'generic-proposal.txt' }),
        },
      };
      await onEvent({ type: 'provider_tool_call_delta', chunk });
      if (streamRequests.length === 1) {
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: callId,
                name: 'fs.read',
                arguments: { path: 'generic-proposal.txt' },
              }],
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [chunk, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: {
                format: 'markdown',
                content: 'The proposal content is accepted even when a duplicate read tool call is present.',
              },
            }),
            toolCalls: [{
              id: callId,
              name: 'fs.read',
              arguments: { path: 'generic-proposal.txt' },
            }],
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-duplicate-proposal',
    content: 'Read a generic file if needed, then answer.',
    attachments: [{ kind: 'directory', path: '.', absolutePath: '/tmp/generic-workspace', source: 'userSelected', scope: 'session' }],
  });

  const nativeResourceResolveManifests = resourceResolveManifests.filter((manifest) =>
    Array.isArray(manifest.entries) && manifest.entries.some((entry: any) => String(entry?.id ?? '').startsWith('native-'))
  );
  assertEqual(nativeResourceResolveManifests.length, 1, 'duplicate proposal path does not call Kernel ResourceResolve twice');
  assertEqual(streamRequests.length, 2, 'valid proposal content stops native tool resume despite duplicate tool call');
  assertEqual(
    result.events.some((event) => event.kind === 'assistant_msg' && String((event.payload as any)?.content ?? '').includes('proposal content is accepted')),
    true,
    'valid proposal content wins over duplicate native read tool call'
  );
}

async function assertSessionDriverLoopNativeWriteToolTriggersImplementationPlanRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  let repairCalls = 0;
  const session: AgentSession = {
    id: 'session-native-write',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-native-write', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native write smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (!request.tools?.length) {
        repairCalls += 1;
        return jsonLlmResponse(genericTaskPlanProposal());
      }
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'tool_call',
        index: 0,
        callId: 'call-generic-write',
        toolCallDelta: {
          id: 'call-generic-write',
          index: 0,
          name: 'fs.write',
          argumentsDelta: '{"path":"generic-output.txt","content":"generic content"}',
        },
      };
      await onEvent({ type: 'provider_tool_call_delta', chunk });
      return {
        ok: true,
        data: {
          chunks: [chunk, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: '',
            toolCalls: [{
              id: 'call-generic-write',
              name: 'fs.write',
              arguments: { path: 'generic-output.txt', content: 'generic content' },
            }],
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + streamRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-write',
    content: '请把 native write 只作为需要审查的计划。',
  });

  assertEqual(streamRequests.length, 2, 'native write is followed by one streaming protocol repair');
  assertEqual(repairCalls, 1, 'native write side effect triggers one protocol repair');
  assertEqual(submittedPlans.length, 0, 'native write repair does not submit executable work before taskPlan acceptance');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  const payload = planCard?.payload as any;
  assertEqual(Boolean(payload?.taskPlan), true, 'native write repair produces a taskPlan card');
  assertEqual(Array.isArray(payload?.codeBlocks) && payload.codeBlocks.length === 0, true, 'taskPlan repair does not carry codeBlocks');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), false, 'native write is not executed as an immediate tool result');
}

async function assertSessionDriverLoopAcceptedPlanNativeWriteToolUsesProposalOnlyRepair(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-native-write-tool', 'run-accepted-plan-native-write-tool')];
  const deltas: unknown[] = [];
  const streamRequests: LlmChatRequest[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-native-write-tool',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-native-write-tool-repair',
              output: { path: 'generic-output.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('accepted-plan native tool violation smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      assertEqual(Boolean(request.tools?.length), false, 'accepted-plan Complete stage uses proposal-only provider calls');
      if (streamRequests.length === 1) {
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId: 'call-generic-complete-write',
          toolCallDelta: {
            id: 'call-generic-complete-write',
            index: 0,
            name: 'fs.write',
            argumentsDelta: '{"path":"generic-output.txt","content":"generic content"}',
          },
        };
        await onEvent({ type: 'provider_tool_call_delta', chunk });
        return {
          ok: true,
          data: {
            chunks: [chunk, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call-generic-complete-write',
                name: 'fs.write',
                arguments: { path: 'generic-output.txt', content: 'generic content' },
              }],
            },
          },
        };
      }
      return jsonLlmResponse(singleTargetWriteProposal('generic-output.txt', 'native-tool-violation-repair'));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-native-write-tool',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(streamRequests.length, 2, 'Complete-stage native tool violation is retried once with proposal-only contract');
  assertEqual(proposalSubmits, 1, 'proposal-only repair returns an actionBundle for Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'proposal-only repair reaches Kernel execution path');
  assertEqual(
    deltas.some((delta) => (delta as any).stage === 'accepted_plan.provider_tool_violation'),
    true,
    'Complete-stage native tool request is surfaced as a Session violation'
  );
  assertEqual(
    deltas.some((delta) => (delta as any).stage === 'native_tool_side_effect_blocked'),
    false,
    'accepted-plan Complete stage does not use native side-effect tool repair'
  );
}

function genericWriteProposal(missingEvidence: boolean): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Create the first small, reviewable scaffold batch for a generic workspace change after user approval.',
      '',
      '## Key Changes',
      '- Write one scoped output file from a top-level code block.',
      '- Keep this batch intentionally small so Kernel facts and user review can inspect the exact file scope.',
      '',
      '## Interfaces',
      '- Use fs.write with sourceBlockId to connect the planned action to the generated code block.',
      '- Do not invoke shell, git, browser, network, or any unsupported capability in this batch.',
      '',
      '## Test Plan',
      '- Kernel should record a write fact for the planned file path.',
      '- User review should inspect the generated path and content before accepting completion.',
      '',
      '## Assumptions',
      '- The target path is inside the authorized workspace or conversation root.',
      '- Follow-up batches, if any, require review before continuation.',
    ].join('\n'),
    codeBlocks: [{
      blockId: 'generic-block',
      targetPath: 'generic-output.txt',
      contentLines: ['generic content'],
    }],
    actionBundle: {
      version: '1',
      id: 'generic-write-bundle',
      goal: 'Create a generic scaffold.',
      actions: [{
        actionId: 'write-generic-output',
        toolId: 'fs.write',
        args: { path: 'generic-output.txt', sourceBlockId: 'generic-block' },
        description: 'Write generic output.',
      }],
      continuationExpectations: [],
      validationExpectations: missingEvidence
        ? []
        : [{ id: 'generic-evidence', description: 'Kernel records the write fact for the generic output.' }],
      reviewExpectations: missingEvidence
        ? []
        : [{ id: 'generic-review', description: 'User reviews the generic output and write scope.' }],
    },
    expectedValidation: 'Kernel records write facts for the generic output.',
    reviewGuide: 'Review the generic output path and content before approval.',
  };
}

function genericTaskPlanProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'taskPlan',
    outputLanguage: 'en-US',
    taskPlan: {
      version: '1',
      id: 'task-plan-generic',
      title: 'Generic task plan',
      summary: 'Plan a generic workspace change before implementation.',
      tasks: [
        {
          taskId: 'task-generic-write',
          title: 'Prepare generic workspace output',
          target: ['generic-output.txt'],
          capability: 'fs.write',
          dependencies: [],
          hardDependencies: [],
          softOrderAfter: [],
          conflictKeys: ['generic-output.txt'],
          canDraftInParallel: true,
          acceptanceCriteria: ['Kernel facts show the accepted target was updated after Complete stage.'],
          failureCriteria: ['Stop if implementation needs targets outside the accepted task plan.'],
        },
      ],
      risks: ['Workspace writes remain under Kernel permission policy.'],
      reviewCheckpoints: ['Review Kernel facts after Complete stage execution.'],
    },
  };
}

function absoluteTargetWriteProposal(targetPath: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    blockId: 'generic-block',
    targetPath,
    contentLines: ['generic content'],
  }];
  (proposal.actionBundle as any).actions[0].args = { path: targetPath, sourceBlockId: 'generic-block' };
  return proposal;
}

function genericPatchProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Patch one previously reviewed generic file using an exact block copied from current ResourcePacket evidence.',
      '',
      '## Key Changes',
      '- Replace a single generic text block instead of rewriting the whole file.',
      '- Keep the edit anchored by patchSpec.match so Kernel can apply the change fail-closed.',
      '',
      '## Interfaces',
      '- Use fs.write with kind=replaceBlock and replacementBlockId.',
      '- Use patchSpec.match.kind=exactBlock with text from current file or search evidence.',
      '',
      '## Test Plan',
      '- Kernel should record a patch work unit for the target file.',
      '- User review should inspect the patch target and generated replacement.',
      '',
      '## Assumptions',
      '- The target file is within the already accepted implementation plan scope.',
      '- The exact match block is present in the latest ResourcePacket evidence.',
    ].join('\n'),
    codeBlocks: [{
      blockId: 'generic-patch-replacement',
      targetPath: 'generic-patch.txt',
      operation: 'replaceBlock',
      contentLines: ['new generic line'],
    }],
    actionBundle: {
      version: '1',
      id: 'generic-patch-bundle',
      goal: 'Patch a generic file with exact evidence.',
      actions: [{
        actionId: 'patch-generic-output',
        toolId: 'fs.patch',
        args: {
          path: 'generic-patch.txt',
          replacementBlockId: 'generic-patch-replacement',
          patchSpec: {
            match: {
              kind: 'exactBlock',
              text: 'old generic line',
            },
          },
        },
        description: 'Patch generic output.',
      }],
      continuationExpectations: [],
      validationExpectations: [{ id: 'generic-patch-evidence', description: 'Kernel records the patch fact for the generic file.' }],
      reviewExpectations: [{ id: 'generic-patch-review', description: 'User reviews the generic patch scope.' }],
    },
    expectedValidation: 'Kernel records patch facts for the generic file.',
    reviewGuide: 'Review the generic patch target and replacement before approval.',
  };
}

function relativeTargetWriteProposal(targetPath: string, blockId: string, actionId: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    blockId,
    targetPath,
    contentLines: [`content for ${targetPath}`],
  }];
  (proposal.actionBundle as any).id = `bundle-${actionId}`;
  (proposal.actionBundle as any).actions[0].actionId = actionId;
  (proposal.actionBundle as any).actions[0].description = `Write ${targetPath}`;
  (proposal.actionBundle as any).actions[0].args = { path: targetPath, sourceBlockId: blockId };
  return proposal;
}

function genericDirectoryResourceEvent(sessionId: string, directoryPath: string, filePaths: string[]): AgentEvent {
  const normalizedDirectory = directoryPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    id: `resource-${normalizedDirectory.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    payload: {
      output: {
        id: `resource-packet-${normalizedDirectory.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
        workspaceScopeKey: 'workspace',
        requestId: 'resource-request-generic-directory',
        items: [{
          requestItemId: 'item-directory',
          manifestEntryId: 'attachment-generic',
          status: 'resolved',
          contentKind: 'directoryTree',
          nodes: [
            {
              name: normalizedDirectory.split('/').pop() ?? normalizedDirectory,
              path: normalizedDirectory,
              type: 'directory',
              children: filePaths.map((path) => ({
                name: path.split('/').pop() ?? path,
                path,
                type: 'file',
                children: null,
              })),
            },
          ],
        }],
      },
    },
  };
}

function deleteActionBundleProposal(targetPath: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Delete one generic obsolete file already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one fs.delete action with a concrete relative target.',
      '',
      '## Interfaces',
      '- Use fs.delete directly; do not attach codeBlocks or sourceBlockId.',
      '',
      '## Test Plan',
      '- Kernel should record a delete work unit fact for the target.',
      '',
      '## Assumptions',
      '- The delete target is inside the accepted workspace scope.',
    ].join('\n'),
    codeBlocks: [],
    actionBundle: {
      version: '1',
      id: 'bundle-generic-delete',
      goal: 'Delete a generic obsolete file.',
      actions: [{
        actionId: 'delete-generic-obsolete',
        toolId: 'fs.delete',
        args: { path: targetPath },
        description: 'Delete generic obsolete file.',
      }],
      continuationExpectations: [],
      validationExpectations: [{ id: 'generic-delete-evidence', description: 'Kernel records the delete fact for the generic obsolete file.' }],
      reviewExpectations: [{ id: 'generic-delete-review', description: 'User reviews the deleted target and Kernel facts.' }],
    },
    expectedValidation: 'Kernel records delete facts for the generic obsolete file.',
    reviewGuide: 'Review the generic delete target before approval.',
  };
}

function manyDeleteActionsProposal(): Record<string, unknown> {
  const proposal = deleteActionBundleProposal('generic-0.tmp');
  (proposal.actionBundle as any).id = 'bundle-many-generic-delete';
  (proposal.actionBundle as any).goal = 'Delete several generic obsolete files.';
  (proposal.actionBundle as any).actions = Array.from({ length: 7 }, (_item, index) => ({
    actionId: `delete-generic-${index}`,
    toolId: 'fs.delete',
    args: { path: `generic-${index}.tmp` },
    description: `Delete generic obsolete file ${index}.`,
  }));
  return proposal;
}

function localizedGenericWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.outputLanguage = 'zh-CN';
  proposal.userPlan = [
    '# 通用计划',
    '',
    '## 概要',
    '为一个通用工作区变更创建一个小批次，保持范围可审查，并等待 Kernel 记录真实执行事实后再进入审查。',
    '',
    '## 关键变更',
    '- 从顶层代码块写入一个受控输出文件。',
    '- 保持本批次足够小，方便用户检查路径、内容和权限范围。',
    '',
    '## 接口与影响面',
    '- 使用 fs.write 与 sourceBlockId 连接计划动作和代码块。',
    '- 不调用命令、Git、网络、浏览器或其他外部能力。',
    '',
    '## 验证计划',
    '- Kernel 应记录目标路径的写入事实。',
    '- 用户审查时应能看到生成文件路径和内容摘要。',
    '',
    '## 假设与约束',
    '- 目标路径位于已授权的工作区或会话资源根内。',
    '- 后续批次仍需要新的计划确认和审查。',
  ].join('\n');
  return proposal;
}

function oversizedGenericWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    blockId: 'generic-oversized-block',
    targetPath: 'generic-oversized-output.txt',
    contentLines: ['x'.repeat(385 * 1024)],
  }];
  (proposal.actionBundle as any).actions[0].args = { path: 'generic-oversized-output.txt', sourceBlockId: 'generic-oversized-block' };
  return proposal;
}

function manyCodeBlockWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = Array.from({ length: 7 }, (_item, index) => ({
    blockId: `generic-block-${index}`,
    targetPath: `generic-output-${index}.txt`,
    contentLines: [`generic content ${index}`],
  }));
  (proposal.actionBundle as any).actions = Array.from({ length: 7 }, (_item, index) => ({
    actionId: `write-generic-output-${index}`,
    toolId: 'fs.write',
    args: { path: `generic-output-${index}.txt`, sourceBlockId: `generic-block-${index}` },
    description: `Write generic output ${index}.`,
  }));
  return proposal;
}

function providerFacingWriteProposalWithoutMachineIds(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  delete (proposal.actionBundle as any).id;
  proposal.codeBlocks = [{
    blockId: 'generic-block',
    targetPath: 'generic-output.txt',
    language: 'text',
    operation: 'create',
    contentLines: ['generic content'],
  }];
  (proposal.actionBundle as any).actions = [{
    actionId: 'write-generic-output',
    description: 'Write generic output',
    toolId: 'fs.write',
    args: { path: 'generic-output.txt', sourceBlockId: 'generic-block' },
    dependsOn: [],
  }];
  return proposal;
}

function jsonLlmResponse(payload: Record<string, unknown>): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'reasoning_delta', content: 'generic reasoning' }, { type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        reasoningContent: 'generic reasoning',
        content: JSON.stringify(payload),
      },
    },
  };
}

function planKernel(
  request: KernelCommandEnvelope,
  sessionId: string,
  submittedPlans: Array<Record<string, any>>
): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') return fakeKernel(request);
  if (command.kind === 'proposalSubmit') {
    submittedPlans.push(command.proposal);
    const actionBundle = command.proposal?.payload?.actionBundle ?? {};
    return {
      ok: true,
      events: [
        {
          kind: 'proposal.accepted',
          runId: 'run-generic',
          sessionId,
          proposal: command.proposal,
        },
        {
          kind: 'proposal.reviewed',
          runId: 'run-generic',
          sessionId,
          proposalId: command.proposal?.proposalId,
          report: proposalReviewReport(actionBundle),
        },
      ],
    };
  }
  if (command.kind === 'reviewGateEvaluate') {
    return {
      ok: true,
      events: [
        {
          kind: 'review_gate.evaluated',
          runId: command.runId ?? 'run-generic',
          sessionId: command.sessionId ?? sessionId,
          result: {
            status: 'accepted',
            summary: 'ReviewGate accepted Kernel facts and user review decision.',
          },
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

function proposalReviewReport(actionBundle: Record<string, any>, attachmentRoot?: string): Record<string, any> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const capabilities = [...new Set(actions.map((action) => actionCapability(action)).filter(Boolean))].sort();
  const permissionGaps = capabilities.filter((capability) => capability !== 'fs.read' && capability !== 'git.read');
  const requiredFileOperations = requiredFileOperationsFromActionBundle(actionBundle, attachmentRoot);
  const requiredAccessScopes = requiredAccessScopesFromActionBundle(actionBundle);
  return {
    planId: actionBundle.id ?? 'bundle-generic',
    status: 'awaitingUserApproval',
    requiredCapabilities: capabilities,
    requiredPermissions: permissionGaps.map((capability) => `temporaryGrant:${capability}`),
    permissionGaps,
    requiredFileOperations,
    requiredAccessScopes,
    hardFloorHits: [],
    deniedReasons: [],
    blockedReasons: [],
    findings: [],
    kernelGeneratedPermissionSummary: `Kernel preflight: status=awaitingUserApproval; capabilities=${capabilities.join(',')}; permissionGaps=${permissionGaps.length ? permissionGaps.join(',') : 'none'}; hardFloor=none.`,
  };
}

function requiredAccessScopesFromActionBundle(actionBundle: Record<string, any>): Array<Record<string, any>> {
  const scopes: Array<Record<string, any>> = [];
  const source = [
    ...(Array.isArray(actionBundle.accessScopes) ? actionBundle.accessScopes : []),
    ...((Array.isArray(actionBundle.actions) ? actionBundle.actions : []).flatMap((action: any) =>
      Array.isArray(action?.accessScopes) ? action.accessScopes : []
    )),
  ];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const path = typeof item.path === 'string' ? item.path.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (!path || path === '.' || path.includes('*') || path.startsWith('../') || path.includes('/../')) continue;
    const capability = typeof item.capability === 'string'
      ? item.capability
      : Array.isArray(item.capabilities) && typeof item.capabilities[0] === 'string'
        ? item.capabilities[0]
        : 'fs.write';
    scopes.push({
      scopeKind: typeof item.scopeKind === 'string' ? item.scopeKind : 'workspaceModule',
      path,
      capability,
      operations: Array.isArray(item.operations) ? item.operations : (capability === 'fs.patch' ? ['patch'] : ['create', 'write']),
      reason: typeof item.reason === 'string' ? item.reason : 'generic access scope',
      dependencyDepth: typeof item.dependencyDepth === 'number' ? item.dependencyDepth : 0,
      outsideWorkspace: false,
    });
  }
  return scopes;
}

function requiredFileOperationsFromActionBundle(actionBundle: Record<string, any>, attachmentRoot?: string): Array<Record<string, any>> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const operations: Array<Record<string, any>> = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const capability = actionCapability(action);
    const operation = fileOperationForAction(action, capability);
    if (!operation) continue;
    const args = action && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : {};
    const targetKind = typeof args.targetKind === 'string' ? args.targetKind : action.targetKind;
    const targetResourceKind = action.targetResourceKind === 'directory' || targetKind === 'directory'
      ? 'directory'
      : typeof action.targetPath === 'string' && action.targetPath.trim().endsWith('/')
        ? 'directory'
        : 'file';
    const rawTarget = typeof action.targetPath === 'string'
      ? action.targetPath
      : Array.isArray(action.resourceScope) && typeof action.resourceScope[0] === 'string'
        ? action.resourceScope[0]
        : typeof args.path === 'string'
          ? args.path
        : '';
    const target = concreteTestTarget(
      targetResourceKind === 'directory' ? rawTarget.replace(/\/+$/, '') : rawTarget,
      attachmentRoot
    );
    if (!target) continue;
    const outsideWorkspace = isAbsoluteTestTarget(target);
    operations.push({
      operation,
      targetPath: target,
      capability,
      actionId: typeof action.actionId === 'string' ? action.actionId : typeof action.id === 'string' ? action.id : '',
      targetKind: outsideWorkspace ? 'absolutePath' : 'workspaceRelative',
      targetResourceKind,
      recursive: action.recursive === true || args.recursive === true || (targetResourceKind === 'directory' && rawTarget.trim().endsWith('/')),
      outsideWorkspace,
    });
  }
  return operations;
}

function actionCapability(action: Record<string, any>): string {
  if (typeof action.capability === 'string' && action.capability) return action.capability;
  const toolId = typeof action.toolId === 'string' ? action.toolId : '';
  if (!toolId) return '';
  if (toolId.startsWith('git.')) return toolId === 'git.status' || toolId === 'git.diff' ? 'git.read' : (toolId === 'git.push' ? 'git.push' : 'git.write');
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
}

function fileOperationForAction(action: Record<string, any>, capability: string): string | undefined {
  const kind = typeof action.kind === 'string' ? action.kind : '';
  if (kind === 'delete') return 'delete';
  if (kind === 'create') return 'create';
  if (kind === 'rename') return 'rename';
  if (['write', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(kind)) return 'write';
  if (capability === 'fs.write') return 'write';
  if (capability === 'fs.patch') return 'write';
  if (capability === 'fs.delete') return 'delete';
  return undefined;
}

function concreteTestTarget(value: string, attachmentRoot?: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsoluteTestTarget(normalized)) {
    const root = attachmentRoot?.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) return undefined;
    if (!root) {
      if (normalized.includes('*') || normalized.endsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
      return normalized;
    }
    if (normalized === root) return undefined;
    if (normalized.startsWith(`${root}/`)) return concreteTestTarget(normalized.slice(root.length + 1));
    if (normalized.includes('*') || normalized.endsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
    return normalized;
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*') || normalized.endsWith('/')) return undefined;
  return normalized;
}

function isAbsoluteTestTarget(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function genericActionBundle(): ActionBundleDraft {
  return {
    version: '1',
    id: 'bundle-generic',
    goal: 'Perform a generic workspace update after review.',
    actions: [
      {
        id: 'read-generic',
        title: 'Read generic resource',
        toolId: 'fs.read',
        args: { path: 'generic/input.txt' },
        kind: 'read',
        capability: 'fs.read',
        resourceScope: ['generic/input.txt'],
        canParallelize: true,
        conflictKeys: [],
      },
      {
        id: 'write-generic',
        title: 'Write generic resource',
        toolId: 'fs.write',
        args: { path: 'generic/output.txt', sourceBlockId: 'code-generic' },
        kind: 'write',
        capability: 'fs.write',
        resourceScope: ['generic/output.txt'],
        canParallelize: false,
        conflictKeys: ['generic/output.txt'],
        sourceBlockId: 'code-generic',
      },
    ],
    validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
    reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
  };
}

function acceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  return {
    id: `event-${runId}-implementation-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId: 'impl-generic-auto',
      title: 'Generic implementation plan',
      summary: 'Implement a generic workspace file update.',
      status: 'pending',
      confirmable: true,
      implementationPlan: {
        version: '1',
        id: 'impl-generic-auto',
        title: 'Generic implementation plan',
        summary: 'Implement a generic workspace file update.',
        tasks: [
          {
            taskId: 'task-generic-write',
            title: 'Write generic output',
            target: ['generic-output.txt'],
            scope: 'Write a generic output file.',
            dependencies: [],
            capability: 'fs.write',
            acceptanceCriteria: ['Kernel records the generic output write fact.'],
            failureCriteria: ['Stop if the write leaves the accepted target scope.'],
          },
        ],
        risks: ['Workspace writes remain under Kernel permission policy.'],
        reviewCheckpoints: ['Review Kernel facts after execution.'],
      },
      actionBundle: {
        version: '1',
        id: 'impl-generic-auto',
        goal: 'Implementation plan placeholder; concrete batches are generated after acceptance.',
        actions: [],
        validationExpectations: [],
        reviewExpectations: [],
      },
      codeBlocks: [],
      commandBlocks: [],
    },
  };
}

function generatedArtifactAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generated-artifact';
  payload.implementationPlan.id = 'impl-generated-artifact';
  payload.implementationPlan.title = 'Generic generated artifact implementation plan';
  payload.implementationPlan.summary = 'Write one file, then read it as current evidence for a dependent write.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generated-input',
      title: 'Write generated input',
      target: ['generic-generated/input.txt'],
      scope: 'Create a generic input artifact inside the accepted workspace scope.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generated input write fact.'],
      failureCriteria: ['Stop if the write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generated-output',
      title: 'Write generated output',
      target: ['generic-generated/output.txt'],
      scope: 'Read the generated input evidence, then create a dependent output artifact.',
      dependencies: ['task-generated-input'],
      hardDependencies: ['task-generated-input'],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generated output write fact.'],
      failureCriteria: ['Stop if the generated input evidence cannot be resolved.'],
    },
  ];
  return event;
}

function userMessageWithDirectoryAttachmentEvent(sessionId: string, root: string): AgentEvent {
  return {
    id: `event-${sessionId}-user-attachment`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: {
      content: 'Please update the generic workspace.',
      attachments: [{
        kind: 'directory',
        path: root,
        absolutePath: root,
        source: 'userSelected',
        scope: 'message',
      }],
    },
  };
}

function multiTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-multi';
  payload.implementationPlan.id = 'impl-generic-multi';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-one',
      title: 'Write generic file one',
      target: ['generic-one.txt'],
      scope: 'Write the first generic file.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the first generic write fact.'],
      failureCriteria: ['Stop if the first write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generic-two',
      title: 'Write generic file two',
      target: ['generic-two.txt'],
      scope: 'Write the second generic file.',
      dependencies: ['task-generic-one'],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the second generic write fact.'],
      failureCriteria: ['Stop if the second write leaves the accepted target scope.'],
    },
  ];
  return event;
}

function commaSeparatedTargetsAcceptedImplementationPlanCardEvent(sessionId: string, runId: string, paths: string[]): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-random-comma';
  payload.implementationPlan.id = 'impl-random-comma';
  payload.implementationPlan.title = 'Random multi-target implementation plan';
  payload.implementationPlan.summary = 'Write all accepted random targets as one reviewed execution batch.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-random-comma-targets',
      title: 'Write random accepted targets',
      target: [paths.join(', ')],
      scope: 'The task target field intentionally carries several concrete file targets in one path-list string.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records write work unit facts for every accepted target.'],
      failureCriteria: ['Stop if any action leaves the accepted target scope.'],
    },
  ];
  return event;
}

function independentMultiTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-independent';
  payload.implementationPlan.id = 'impl-generic-independent';
  for (const task of payload.implementationPlan.tasks ?? []) {
    task.dependencies = [];
  }
  return event;
}

function explicitDagAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-dag';
  payload.implementationPlan.id = 'impl-generic-dag';
  payload.implementationPlan.title = 'Generic DAG implementation plan';
  payload.implementationPlan.summary = 'Generate two independent module drafts, then a dependent module draft.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-alpha',
      title: 'Write generic alpha output',
      target: ['generic-alpha/output.txt'],
      scope: 'Write a generic alpha output file.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generic alpha write fact.'],
      failureCriteria: ['Stop if the alpha write leaves accepted scope.'],
    },
    {
      taskId: 'task-generic-beta',
      title: 'Write generic beta output',
      target: ['generic-beta/output.txt'],
      scope: 'Write a generic beta output file.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generic beta write fact.'],
      failureCriteria: ['Stop if the beta write leaves accepted scope.'],
    },
    {
      taskId: 'task-generic-gamma',
      title: 'Write generic gamma output',
      target: ['generic-gamma/output.txt'],
      scope: 'Write a generic gamma output after alpha and beta drafts are ready.',
      dependencies: ['task-generic-alpha', 'task-generic-beta'],
      hardDependencies: ['task-generic-alpha', 'task-generic-beta'],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generic gamma write fact.'],
      failureCriteria: ['Stop if the gamma write leaves accepted scope.'],
    },
  ];
  payload.implementationPlan.executionFlowGraph = {
    graphId: 'flow-generic-dag',
    nodes: [
      {
        nodeId: 'node-generic-alpha',
        moduleId: 'module-generic-alpha',
        modulePath: 'generic-alpha',
        taskIds: ['task-generic-alpha'],
        targets: ['generic-alpha/output.txt'],
        capabilities: ['fs.write'],
        prerequisites: [],
        outputs: ['generic-alpha/output.txt'],
        dependsOn: [],
        unlocks: ['node-generic-gamma'],
        conflictKeys: ['generic-alpha/output.txt'],
        evidenceNeeds: [],
      },
      {
        nodeId: 'node-generic-beta',
        moduleId: 'module-generic-beta',
        modulePath: 'generic-beta',
        taskIds: ['task-generic-beta'],
        targets: ['generic-beta/output.txt'],
        capabilities: ['fs.write'],
        prerequisites: [],
        outputs: ['generic-beta/output.txt'],
        dependsOn: [],
        unlocks: ['node-generic-gamma'],
        conflictKeys: ['generic-beta/output.txt'],
        evidenceNeeds: [],
      },
      {
        nodeId: 'node-generic-gamma',
        moduleId: 'module-generic-gamma',
        modulePath: 'generic-gamma',
        taskIds: ['task-generic-gamma'],
        targets: ['generic-gamma/output.txt'],
        capabilities: ['fs.write'],
        prerequisites: ['node-generic-alpha draft ready', 'node-generic-beta draft ready'],
        outputs: ['generic-gamma/output.txt'],
        dependsOn: ['node-generic-alpha', 'node-generic-beta'],
        unlocks: [],
        conflictKeys: ['generic-gamma/output.txt'],
        evidenceNeeds: ['direct predecessor draft summaries'],
      },
    ],
  };
  return event;
}

function singleModuleAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-single-module';
  payload.implementationPlan.id = 'impl-generic-single-module';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-module-header',
      title: 'Write generic module header',
      target: ['generic-module/header.txt'],
      scope: 'Write the first file in one generic module.',
      dependencies: [],
      hardDependencies: [],
      softOrderAfter: [],
      conflictKeys: ['generic-module/header.txt'],
      canDraftInParallel: true,
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the first module file write fact.'],
      failureCriteria: ['Stop if the first module file leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generic-module-source',
      title: 'Write generic module source',
      target: ['generic-module/source.txt'],
      scope: 'Write the second file in the same generic module after the first file.',
      dependencies: [],
      hardDependencies: ['task-generic-module-header'],
      softOrderAfter: [],
      conflictKeys: ['generic-module/source.txt'],
      canDraftInParallel: true,
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the second module file write fact.'],
      failureCriteria: ['Stop if the second module file leaves the accepted target scope.'],
    },
  ];
  return event;
}

function hardDependencyAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-hard';
  payload.implementationPlan.id = 'impl-generic-hard';
  payload.implementationPlan.tasks[0].role = 'sourceCode';
  payload.implementationPlan.tasks[0].target = ['generic-one/output.txt'];
  payload.implementationPlan.tasks[0].conflictKeys = ['generic-one.txt'];
  payload.implementationPlan.tasks[0].canDraftInParallel = true;
  payload.implementationPlan.tasks[1].role = 'sourceCode';
  payload.implementationPlan.tasks[1].target = ['generic-two/output.txt'];
  payload.implementationPlan.tasks[1].dependencies = [];
  payload.implementationPlan.tasks[1].hardDependencies = ['task-generic-one'];
  payload.implementationPlan.tasks[1].softOrderAfter = [];
  payload.implementationPlan.tasks[1].conflictKeys = ['generic-two.txt'];
  payload.implementationPlan.tasks[1].canDraftInParallel = true;
  return event;
}

function deleteAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-delete';
  payload.implementationPlan.id = 'impl-generic-delete';
  payload.implementationPlan.title = 'Generic delete implementation plan';
  payload.implementationPlan.summary = 'Remove one generic obsolete workspace file.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-delete',
      title: 'Delete generic obsolete file',
      target: ['generic-obsolete.txt'],
      scope: 'Delete a generic obsolete file inside the accepted workspace scope.',
      dependencies: [],
      capability: 'fs.delete',
      acceptanceCriteria: ['Kernel records the delete work unit fact for the generic obsolete file.'],
      failureCriteria: ['Stop if the delete target is empty, root, absolute, or outside the accepted target scope.'],
    },
  ];
  return event;
}

function singleTargetWriteProposal(targetPath: string, contentSuffix: string): Record<string, unknown> {
  const blockId = `code-${contentSuffix}`;
  const actionId = `write-${contentSuffix}`;
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Generic task slice',
      '',
      '## Summary',
      `Write the accepted target ${targetPath} as one independent task slice.`,
      '',
      '## Key Changes',
      '- Produce one code block for the accepted target.',
      '- Produce one fs.write action scoped to that same target.',
      '- Do not introduce shell, git, network, browser, or provider egress actions.',
      '',
      '## Validation',
      '- Kernel should record a work unit for the accepted target.',
      '- Parent Session should merge this fragment with sibling independent fragments before submitting.',
      '',
      '## Assumptions',
      '- The target belongs to the accepted implementationPlan file scope.',
    ].join('\n'),
    codeBlocks: [
      { blockId, targetPath, contentLines: [`generic ${contentSuffix}`] },
    ],
    actionBundle: {
      version: '1',
      id: `bundle-${contentSuffix}`,
      goal: `Write ${targetPath}.`,
      actions: [{
        actionId,
        toolId: 'fs.write',
        args: { path: targetPath, sourceBlockId: blockId },
        description: `Write ${targetPath}`,
      }],
      validationExpectations: [{ id: `validation-${contentSuffix}`, description: `Kernel records ${targetPath}.` }],
      reviewExpectations: [{ id: `review-${contentSuffix}`, description: `Review ${targetPath}.` }],
    },
    expectedValidation: `Kernel records ${targetPath}.`,
    reviewGuide: `Review ${targetPath}.`,
  };
}

function singleTargetModuleDraft(targetPath: string, contentSuffix: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.subagent.module-draft.v1',
    kind: 'subAgentModuleDraft',
    moduleId: `module-${contentSuffix}`,
    targets: [targetPath],
    draftFiles: [
      {
        targetPath,
        operation: 'write',
        language: 'text',
        contentLines: [`generic ${contentSuffix}`],
        summary: `Draft ${targetPath}`,
      },
    ],
    evidenceSummary: [`Prepared a candidate draft for ${targetPath}.`],
    assumptions: ['Parent Session validates, merges, and submits the final actionBundle.'],
    diagnostics: [],
  };
}

function genericDiagnosticProposal(summary: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'diagnostic',
    outputLanguage: 'en-US',
    diagnostic: {
      version: '1',
      id: 'diagnostic-generic',
      severity: 'warning',
      summary,
    },
  };
}

function processExecAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-exec';
  payload.implementationPlan.id = 'impl-generic-exec';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-exec',
      title: 'Run generic validation',
      target: ['scripts/validate.sh'],
      scope: 'Run a generic validation command described by the accepted plan.',
      dependencies: [],
      capability: 'process.exec',
      acceptanceCriteria: ['Kernel permission gate owns the process execution decision.'],
      failureCriteria: ['Stop if Session asks for a new technical plan instead of using Kernel PermissionGate.'],
    },
  ];
  return event;
}

function multiWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [
    { id: 'code-one', targetPath: 'generic-one.txt', content: 'one' },
    { id: 'code-two', targetPath: 'generic-two.txt', content: 'two' },
  ];
  proposal.actionBundle = multiWriteActionBundle();
  return proposal;
}

function randomMultiWriteProposal(paths: string[], options?: { briefUserPlan?: boolean }): Record<string, unknown> {
  const token = randomSmokeToken('bundle');
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: options?.briefUserPlan
      ? `## Batch\n\nWrite ${paths.length} accepted target file(s).`
      : [
        '# Random multi-target batch',
        '',
        '## Summary',
        `Write ${paths.length} accepted target file(s) in one reviewed execution batch.`,
        '',
        '## Key Changes',
        '- Produce one code block for each accepted target path.',
        '- Produce one fs.write action for each code block.',
        '- Keep every write target inside the already accepted implementation plan scope.',
        '',
        '## Validation',
        '- Kernel should record one work unit fact for each target path.',
        '- Session should not create a user-intervention request for in-scope targets.',
        '',
        '## Assumptions',
        '- The accepted implementation plan already declared the target paths.',
      ].join('\n'),
    codeBlocks: paths.map((path, index) => ({
      blockId: `code-${token}-${index}`,
      targetPath: path,
      contentLines: [`content ${randomSmokeToken('content')}`],
    })),
    actionBundle: {
      version: '1',
      id: `bundle-${token}`,
      goal: 'Write accepted random target files.',
      actions: paths.map((path, index) => ({
        actionId: `write-${token}-${index}`,
        toolId: 'fs.write',
        args: { path, sourceBlockId: `code-${token}-${index}` },
        description: `Write ${path}`,
        canParallelize: false,
        conflictKeys: [path],
      })),
      validationExpectations: [{ id: `validation-${token}`, description: 'Kernel records write work unit facts for all target paths.' }],
      reviewExpectations: [{ id: `review-${token}`, description: 'User reviews the generated target files and Kernel facts.' }],
    },
    expectedValidation: 'Kernel records write facts for all target paths.',
    reviewGuide: 'Review the generated files and Kernel facts.',
  };
}

function multiWriteActionBundle(): Record<string, any> {
  return {
    version: '1',
    id: 'bundle-multi-write',
    goal: 'Write multiple generic files in one reviewed batch.',
    actions: [
      {
        actionId: 'write-generic-one',
        toolId: 'fs.write',
        args: { path: 'generic-one.txt', sourceBlockId: 'code-one' },
        description: 'Write generic file one.',
        canParallelize: false,
        conflictKeys: ['generic-one.txt'],
      },
      {
        actionId: 'write-generic-two',
        toolId: 'fs.write',
        args: { path: 'generic-two.txt', sourceBlockId: 'code-two' },
        description: 'Write generic file two.',
        canParallelize: false,
        conflictKeys: ['generic-two.txt'],
      },
    ],
    validationExpectations: [{ id: 'validation-multi', description: 'Kernel records file write facts.' }],
    reviewExpectations: [{ id: 'review-multi', description: 'User reviews all written files.' }],
  };
}

function processExecProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Run the generic validation command already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one planned process execution action with typed command args.',
      '- Keep the command inside the accepted target and capability scope.',
      '',
      '## Interfaces',
      '- Use process.exec with argv/cwd args so Kernel owns permission and execution.',
      '',
      '## Test Plan',
      '- Kernel should either request permission or record command execution facts.',
      '',
      '## Assumptions',
      '- The command target was already included in the accepted implementation plan.',
    ].join('\n'),
    actionBundle: {
      version: '1',
      id: 'bundle-generic-exec',
      goal: 'Run generic validation.',
      actions: [{
        actionId: 'run-generic-validation',
        toolId: 'process.exec',
        args: {
          cwd: '.',
          argv: ['bash', 'scripts/validate.sh'],
          timeoutMs: 30000,
          envPolicy: 'inheritSafe',
          expectedOutput: 'generic validation output',
          targetPath: 'scripts/validate.sh',
        },
        description: 'Run generic validation',
      }],
      validationExpectations: [{ id: 'validation-exec', description: 'Kernel records permission or command facts for the generic validation.' }],
      reviewExpectations: [{ id: 'review-exec', description: 'User can inspect Kernel permission and command facts.' }],
    },
    expectedValidation: 'Kernel records permission or command facts for the generic validation.',
    reviewGuide: 'Review Kernel permission and command facts.',
  };
}

function fakeKernel(request: KernelCommandEnvelope): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') {
    const toolCatalogSnapshot = genericToolCatalogSnapshot();
    return {
      ok: true,
      events: [
        {
          kind: 'state.entered',
          runId: 'run-generic',
          sessionId: 'session-generic',
          stateContract: {
            runId: 'run-generic',
            stateId: 'needProposal',
            stateKind: 'driverRequest',
            allowedInputs: ['proposalSubmit', 'resourceResolve'],
            allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
            proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
            capabilityProjection: ['fs.read', 'fs.write'],
            toolCatalogSnapshot,
          },
        },
        {
          kind: 'driver.request_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          driverRequest: {
            id: 'driver-generic',
            runId: 'run-generic',
            sessionId: 'session-generic',
            kind: 'needProposal',
            reason: 'Need a v3 proposal.',
            stateContract: {
              runId: 'run-generic',
              stateId: 'needProposal',
              stateKind: 'driverRequest',
              allowedInputs: ['proposalSubmit', 'resourceResolve'],
              allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
              proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
              capabilityProjection: ['fs.read', 'fs.write'],
              toolCatalogSnapshot,
            },
          },
        },
      ],
    };
  }
  if (command.kind === 'resourceResolve') {
    return {
      ok: true,
      events: [
        {
          kind: 'resource.packet_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          packet: {
            id: 'packet-generic',
            requestId: command.requestId,
            items: [
              {
                requestItemId: 'item-generic',
                manifestEntryId: command.request.manifest.entries[0].id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: 'file',
                contentKind: 'fileText',
                content: 'resolved generic content',
                evidenceRefs: ['evidence-generic'],
              },
            ],
          },
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

function genericToolCatalogSnapshot(): Record<string, unknown> {
  const base = {
    family: 'workspace',
    risk: 'low',
    permissionMode: 'allow',
    pathScopePolicy: 'workspace',
    executionMode: 'execute',
    needsWorkspace: true,
    readOnly: true,
  };
  return {
    catalogVersion: 'test-v1',
    catalogHash: 'test-tool-catalog',
    tools: [
      {
        ...base,
        toolId: 'fs.read',
        capability: 'fs.read',
        operationKind: 'read',
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        ...base,
        toolId: 'fs.list',
        capability: 'fs.read',
        operationKind: 'list',
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        ...base,
        toolId: 'fs.write',
        capability: 'fs.write',
        operationKind: 'write',
        permissionMode: 'ask',
        readOnly: false,
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, sourceBlockId: { type: 'string' } },
          required: ['path', 'sourceBlockId'],
        },
      },
    ],
  };
}

function fakeLlm(_request: LlmChatRequest): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'The attached generic resource was resolved through Kernel ResourceResolve.' },
        }),
      },
    },
  };
}

function randomSmokeToken(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertCancelledRunState(
  events: AgentEvent[],
  reason: string,
  runId: string,
  targetId?: string
): void {
  const event = events.find((candidate) =>
    candidate.kind === 'session_run_state' &&
    (candidate.payload as any)?.status === 'cancelled' &&
    (candidate.payload as any)?.phase === 'cancelled' &&
    (candidate.payload as any)?.reason === reason &&
    (candidate.payload as any)?.runId === runId &&
    (targetId ? (candidate.payload as any)?.targetId === targetId : true)
  );
  assert(Boolean(event), `expected cancelled session run state for ${reason}`);
}

function assertThrows(fn: () => unknown, expectedMessage: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) return;
    throw error;
  }
  throw new Error(`expected function to throw: ${expectedMessage}`);
}

function taskStatus(graph: ReturnType<typeof buildSessionTaskGraph>, id: string): string | undefined {
  return graph.tasks.find((task) => task.id === id)?.status;
}

main().catch((error) => {
  console.error(error);
  throw error;
});
