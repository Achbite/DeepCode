import type { AgentSessionResult } from '@deepcode/protocol';
import {
  appendTaskLocalCompactRecord,
  assembleContext,
  buildTaskLocalCompactRecord,
  buildPromptEnvelope,
  buildResourcePromptContext,
  buildSessionMemoryDocument,
  collectTaskLocalCompactRecords,
  createResourcePacket,
  type ResourceManifest,
} from '../index.js';
import type { AcceptedImplementationPlanContext } from '../accepted-plan/index.js';
import { ContextFrameBuilder } from '../driver/context/contextFrameBuilder.js';
import { renderProviderTurnUserPrompt } from '../driver/context/providerTurnPromptRenderer.js';
import {
  buildProviderTurnSnapshot,
  ProviderTurnContextCoordinator,
} from '../driver/context/index.js';
import { HookPolicy, HookRegistry, HookRuntime } from '../driver/hooks/index.js';
import { RequirementConfirmationCoordinator } from '../driver/interactions/index.js';
import { SessionProgressProjectionBuilder } from '../driver/projection/index.js';
import { routeProposalKind } from '../driver/proposal/proposalRouter.js';
import { acceptedPlanContinuationInput, decisionContinuationInput } from '../driver/runContinuation.js';
import { RunEngine } from '../driver/runEngine.js';
import { buildTaskLedgerSnapshot } from '../run-state/index.js';
import {
  assert,
  assertEqual,
  randomSmokeToken,
} from './smokeHelpers.js';
import {
  genericProposal,
  genericSessionResult,
  genericToolCatalogSnapshot,
} from './smokeFixtures.js';

export function assertProviderTurnContractFrameOrder(): void {
  const contract = new ContextFrameBuilder().buildProviderTurnContract({
    contractId: 'contract-smoke',
    sessionId: 'session-smoke',
    runId: 'run-smoke',
    turnMode: 'acceptedTaskExecution',
    allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
    prompt: buildPromptEnvelope({
      workflowState: 'acceptedTaskExecution',
      allowedProposals: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
      capabilityCatalogSummary: 'fs.read\nfs.write',
      userRequest: 'Create generic files under the current task.',
    }),
    userRequest: 'Create generic files under the current task.',
    currentTask: {
      taskId: 'task-1',
      title: 'Create generic files',
      goal: 'Create generic files under target directory',
      targets: ['src/example.txt'],
    },
    resourceEvidenceRefs: ['packet-1'],
    accessSummary: 'resourcePackets=1; generatedArtifacts=0; currentTask=task-1',
    nextActionInstruction: 'Use the current task cursor only.',
  });
  const kinds = contract.frames.map((frame) => frame.kind);
  assertEqual(kinds[0], 'SystemContract', 'provider turn contract starts with system contract');
  assertEqual(kinds[1], 'ProtocolContract', 'provider turn contract keeps protocol contract before dynamic context');
  assertEqual(kinds[2], 'MemoryPlaceholder', 'provider turn contract places memory placeholder before dynamic dialogue');
  assertEqual(kinds[3], 'DynamicDialogue', 'provider turn contract places dynamic dialogue after memory placeholder');
  assertEqual(kinds.includes('AccessIndex'), true, 'provider turn contract includes access index');
  assertEqual(kinds.includes('HookContext'), true, 'provider turn contract includes hook context');
  assertEqual(kinds.includes('ProviderStepSummary'), true, 'provider turn contract includes provider step summary');
  assertEqual(kinds.at(-1), 'NextActionInstruction', 'provider turn contract ends with next action instruction');
  const resourceFrame = contract.frames.find((frame) => frame.kind === 'ResourceEvidence');
  assertEqual(resourceFrame?.trust, 'kernelObservedFact', 'resource evidence is marked as Kernel-observed fact');
  const accessFrame = contract.frames.find((frame) => frame.kind === 'AccessIndex');
  assertEqual(accessFrame?.trust, 'derivedObservedFact', 'access index is marked as derived observed fact');
  const memoryFrame = contract.frames.find((frame) => frame.kind === 'MemoryPlaceholder');
  assertEqual(memoryFrame?.trust, 'compressedReference', 'memory is marked as compressed reference');
  assertEqual(contract.nextActionInstruction.kind, 'NextActionInstruction', 'contract exposes next action instruction directly');

  const planningContract = new ContextFrameBuilder().buildSessionProviderTurnContract({
    contractId: 'contract-planning-smoke',
    sessionId: 'session-planning-smoke',
    runId: 'run-planning-smoke',
    allowedKinds: ['answer', 'resourceRequest', 'taskPlan'],
    prompt: buildPromptEnvelope({
      workflowState: 'needProposal',
      allowedProposals: ['answer', 'resourceRequest', 'taskPlan'],
      capabilityCatalogSummary: 'fs.read',
      userRequest: 'Analyze a generic workspace.',
    }),
    userRequest: 'Analyze a generic workspace.',
    resourcePackets: [],
    generatedArtifactCount: 0,
  });
  assert(
    String(planningContract.nextActionInstruction.summary ?? '').includes('Use exactly one registered planning semantic tool'),
    'planning provider turn requires one Session semantic directive'
  );
  assert(
    String(planningContract.nextActionInstruction.summary ?? '').includes('session.request_decision only when a blocking user choice'),
    'planning provider turn keeps decision requests behind blocking choices'
  );
  assert(
    String(planningContract.nextActionInstruction.summary ?? '').includes('do not re-audit protocol rules, permission gates, resource policy'),
    'planning provider turn keeps reasoning focused on current frames'
  );
  assert(
    String(planningContract.nextActionInstruction.summary ?? '').includes('Keep visible reasoning/progress action-oriented'),
    'planning provider turn keeps visible reasoning action oriented'
  );
}

export function assertDecisionContinuationInputKeepsDecisionResumeInSameLoop(): void {
  const token = randomSmokeToken('decision-continuation');
  const sourceOverlay = {
    parentRunId: `parent-${token}`,
    parentPhase: 'waiting_plan_review' as const,
    interactionRunId: `run-${token}`,
    interactionId: `plan-${token}`,
  };
  const overrideOverlay = {
    parentRunId: `parent-${token}`,
    parentPhase: 'waiting_review' as const,
    interactionRunId: `run-${token}`,
    interactionId: `review-${token}`,
  };
  const input = decisionContinuationInput({
    sessionId: `session-${token}`,
    workspaceBinding: { workspaceId: `workspace-${token}` } as any,
    projectWorkingDirectory: { path: `/tmp/workspace-${token}` } as any,
    profileId: `profile-${token}`,
    workflow: `workflow-${token}`,
    reviewContinuationMode: 'ask',
    interventionLevel: 'medium',
    projectMemoryMode: 'auto',
    interactionOverlay: sourceOverlay,
  }, {
    content: `continue ${token}`,
    existingEvents: [],
    reviewContinuationMode: 'auto',
    interactionOverlay: overrideOverlay,
    resumeResourcePackets: true,
    confirmedRequirement: { requirementId: `requirement-${token}`, status: 'confirmed' } as any,
  });
  assertEqual(input.appendUserMessage, false, 'decision continuation never appends a new user message');
  assertEqual(input.requirementConfirmationMode, 'off', 'decision continuation does not re-enter requirement confirmation');
  assertEqual(input.reviewContinuationMode, 'auto', 'decision continuation allows explicit continuation mode override');
  assertEqual(input.interactionOverlay, overrideOverlay, 'decision continuation preserves the active owner override');
  assertEqual(input.resumeResourcePackets, true, 'decision continuation can carry resource packets into the same loop');
  assertEqual(input.confirmedRequirement?.requirementId, `requirement-${token}`, 'decision continuation can carry confirmed requirement authority');

  const rootIsolated = decisionContinuationInput({
    sessionId: `session-root-isolated-${token}`,
    workspaceBinding: { workspaceId: `decision-workspace-${token}` } as any,
    projectWorkingDirectory: { path: `/tmp/decision-workspace-${token}` } as any,
  }, {
    content: `continue with original root ${token}`,
    existingEvents: [],
    workspaceBinding: undefined,
    projectWorkingDirectory: undefined,
  });
  assertEqual(rootIsolated.workspaceBinding, undefined, 'decision continuation can clear a host-shell workspace binding');
  assertEqual(rootIsolated.projectWorkingDirectory, undefined, 'decision continuation can clear a host-shell project working directory');

  const minimal = decisionContinuationInput({ sessionId: `session-minimal-${token}` }, {
    content: `resume ${token}`,
    existingEvents: [],
    resumeResourcePackets: true,
  });
  assertEqual(minimal.sessionId, `session-minimal-${token}`, 'decision continuation accepts minimal coordinator input');
  assertEqual(minimal.attachments?.length, 0, 'decision continuation defaults missing attachments to an empty list');
  assertEqual(minimal.appendUserMessage, false, 'minimal continuation still does not append a new user message');
  assertEqual(minimal.requirementConfirmationMode, 'off', 'minimal continuation still avoids requirement reconfirmation');
}

export function assertAcceptedPlanContinuationDefaultsResourceResume(): void {
  const token = randomSmokeToken('accepted-plan-continuation');
  const acceptedPlan = {
    planId: `plan-${token}`,
    tasks: [],
    completedTaskIds: [],
  } as unknown as AcceptedImplementationPlanContext;
  const input = acceptedPlanContinuationInput({
    sessionId: `session-${token}`,
    reviewContinuationMode: 'auto',
  }, {
    content: `continue accepted plan ${token}`,
    existingEvents: [],
    acceptedImplementationPlan: acceptedPlan,
  });
  assertEqual(input.appendUserMessage, false, 'accepted-plan continuation does not append a new user message');
  assertEqual(input.requirementConfirmationMode, 'off', 'accepted-plan continuation does not re-enter requirement confirmation');
  assertEqual(input.resumeResourcePackets, true, 'accepted-plan continuation defaults resource packet resume on');
  assertEqual(input.acceptedImplementationPlan, acceptedPlan, 'accepted-plan continuation carries accepted plan authority');
}

export async function assertRunEngineContinuationUsesSameLifecycle(): Promise<void> {
  const token = randomSmokeToken('run-engine-continuation');
  const calls: string[] = [];
  const proposal = genericProposal(`answer-${token}`, 'answer');
  const result: AgentSessionResult = {
    session: {
      id: `session-${token}`,
      mode: 'plan',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      eventCount: 0,
    },
    events: [],
  };
  const engine = new RunEngine<
    { sessionId: string },
    { sessionId: string; runId: string; phase: string }
  >({
    initialize: async () => {
      throw new Error('continuation smoke should not initialize a new run');
    },
    resume: async (input) => {
      calls.push(`resume:${input.sessionId}`);
      return {
        state: { sessionId: input.sessionId, runId: `run-${token}`, phase: 'initialized' },
        lastResult: result,
      };
    },
    shouldBuildRequirementConfirmation: () => {
      calls.push('maybe-requirement');
      return false;
    },
    waitForRequirementDecision: async () => {
      throw new Error('continuation smoke should not wait for requirement decision');
    },
    runProviderTurn: async ({ state }) => {
      calls.push(`provider:${state.phase}`);
      return {
        kind: 'directiveReady',
        prompt: { messages: [] } as never,
        lastResult: result,
        proposal,
        directive: routeProposalKind(proposal),
      };
    },
    executeDirective: async ({ routed }) => {
      calls.push(`directive:${routed?.kind}`);
      return { kind: 'return', result };
    },
    assembleReview: async () => {
      throw new Error('continuation smoke should not assemble review');
    },
  });

  const output = await engine.resume({ sessionId: `session-${token}` });
  assertEqual(output, result, 'RunEngine continuation returns provider cycle result');
  assertEqual(
    calls.join('|'),
    `resume:session-${token}|maybe-requirement|provider:initialized|directive:answer`,
    'RunEngine continuation rehydrates the same lifecycle through an explicit command'
  );
}

export async function assertRunEngineOwnsNativeProviderResume(): Promise<void> {
  const token = randomSmokeToken('run-engine-native-resume');
  const initial = genericSessionResult(`session-${token}`);
  const final = genericSessionResult(`session-final-${token}`);
  const proposal = genericProposal(`answer-${token}`, 'answer');
  let providerTurns = 0;
  let directiveExecutions = 0;
  const engine = new RunEngine<
    { sessionId: string },
    { sessionId: string; runId: string; phase: string }
  >({
    initialize: async (input) => ({
      state: { sessionId: input.sessionId, runId: `run-${token}`, phase: 'initialized' },
      lastResult: initial,
    }),
    resume: async () => {
      throw new Error('native provider resume stays inside the active RunEngine');
    },
    shouldBuildRequirementConfirmation: () => false,
    waitForRequirementDecision: async () => {
      throw new Error('native provider resume does not open requirement confirmation');
    },
    runProviderTurn: async () => {
      providerTurns += 1;
      return providerTurns === 1
        ? {
          kind: 'directiveReady',
          prompt: { messages: [] } as never,
          lastResult: initial,
          directive: { kind: 'providerResume' },
        }
        : {
          kind: 'directiveReady',
          prompt: { messages: [] } as never,
          lastResult: initial,
          proposal,
          directive: routeProposalKind(proposal),
        };
    },
    executeDirective: async () => {
      directiveExecutions += 1;
      return { kind: 'return', result: final };
    },
    assembleReview: async () => {
      throw new Error('native provider resume test does not assemble Review');
    },
  });

  const output = await engine.run({ sessionId: `session-${token}` });
  assertEqual(output, final, 'RunEngine returns the proposal result after native provider resume');
  assertEqual(providerTurns, 2, 'RunEngine owns both provider steps around the native read');
  assertEqual(directiveExecutions, 1, 'native provider resume does not enter proposal side-effect execution');
}

export async function assertRunEngineContinuesOnlyForResourceRequestRoute(): Promise<void> {
  const token = randomSmokeToken('run-engine-route');
  const firstResult = genericSessionResult(`session-${token}`);
  const finalResult = genericSessionResult(`session-final-${token}`);
  const resourceProposal = genericProposal(`resource-${token}`, 'resourceRequest');
  const answerProposal = genericProposal(`answer-${token}`, 'answer');
  let providerTurns = 0;
  let directiveTurns = 0;
  const engine = new RunEngine<
    { sessionId: string },
    { sessionId: string; runId: string; phase: string }
  >({
    initialize: async (input) => ({
      state: { sessionId: input.sessionId, runId: `run-${token}`, phase: 'initialized' },
      lastResult: firstResult,
    }),
    resume: async () => {
      throw new Error('resource continuation smoke should not resume an external decision');
    },
    shouldBuildRequirementConfirmation: () => false,
    waitForRequirementDecision: async () => {
      throw new Error('resource continuation smoke should not wait for requirement decision');
    },
    runProviderTurn: async () => {
      providerTurns += 1;
      if (providerTurns === 1) {
        return {
          kind: 'directiveReady',
          prompt: { messages: [] } as never,
          lastResult: firstResult,
          proposal: resourceProposal,
          directive: routeProposalKind(resourceProposal),
        };
      }
      return {
        kind: 'directiveReady',
        prompt: { messages: [] } as never,
        lastResult: firstResult,
        proposal: answerProposal,
        directive: routeProposalKind(answerProposal),
      };
    },
    executeDirective: async ({ routed }) => {
      directiveTurns += 1;
      return routed?.kind === 'resourceRequest'
        ? { kind: 'continue', lastResult: firstResult }
        : { kind: 'return', result: finalResult };
    },
    assembleReview: async () => {
      throw new Error('resource continuation smoke should not assemble review');
    },
  });

  const output = await engine.run({ sessionId: `session-${token}` });
  assertEqual(output, finalResult, 'RunEngine resumes provider after routed resourceRequest continuation');
  assertEqual(providerTurns, 2, 'RunEngine limits continue loops to explicit resourceRequest evidence refresh');
  assertEqual(directiveTurns, 2, 'RunEngine executes each admitted directive through its command loop');
}

export async function assertRunEngineRejectsUnexpectedContinueRoute(): Promise<void> {
  const token = randomSmokeToken('run-engine-route-guard');
  const result = genericSessionResult(`session-${token}`);
  const answerProposal = genericProposal(`answer-${token}`, 'answer');
  const engine = new RunEngine<
    { sessionId: string },
    { sessionId: string; runId: string; phase: string }
  >({
    initialize: async (input) => ({
      state: { sessionId: input.sessionId, runId: `run-${token}`, phase: 'initialized' },
      lastResult: result,
    }),
    resume: async () => {
      throw new Error('route guard smoke should not resume an external decision');
    },
    shouldBuildRequirementConfirmation: () => false,
    waitForRequirementDecision: async () => {
      throw new Error('route guard smoke should not wait for requirement decision');
    },
    runProviderTurn: async () => ({
      kind: 'directiveReady',
      prompt: { messages: [] } as never,
      lastResult: result,
      proposal: answerProposal,
      directive: routeProposalKind(answerProposal),
    }),
    executeDirective: async () => ({ kind: 'continue', lastResult: result }),
    assembleReview: async () => {
      throw new Error('route guard smoke should not assemble review');
    },
  });

  try {
    await engine.run({ sessionId: `session-${token}` });
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes('directive continue requires resourceRequest or action'),
      'RunEngine rejects non-resourceRequest directive continue results'
    );
    return;
  }
  throw new Error('expected RunEngine to reject non-resourceRequest provider continue results');
}

export async function assertRunEngineOwnsReviewAssembly(): Promise<void> {
  const token = randomSmokeToken('run-engine-review');
  const initialResult = genericSessionResult(`session-${token}`);
  const reviewResult = genericSessionResult(`session-review-${token}`);
  const proposal = genericProposal(`action-${token}`, 'actionBundle');
  let initializeCalls = 0;
  let reviewCalls = 0;
  const reviewRequest = {
    sessionId: initialResult.session.id,
    runId: `run-${token}`,
    planId: `plan-${token}`,
    plan: {},
    result: initialResult,
    currentKernelEvents: [],
    requestIdPrefix: `review-${token}`,
  } as never;
  const engine = new RunEngine<
    { sessionId: string },
    { sessionId: string; runId: string; phase: string }
  >({
    initialize: async (input) => {
      initializeCalls += 1;
      return {
        state: { sessionId: input.sessionId, runId: `run-${token}`, phase: 'initialized' },
        lastResult: initialResult,
      };
    },
    resume: async () => {
      throw new Error('review assembly smoke should not resume an external decision');
    },
    shouldBuildRequirementConfirmation: () => false,
    waitForRequirementDecision: async () => {
      throw new Error('review assembly smoke should not wait for requirement decision');
    },
    runProviderTurn: async () => ({
      kind: 'directiveReady',
      prompt: { messages: [] } as never,
      lastResult: initialResult,
      proposal,
      directive: routeProposalKind(proposal),
    }),
    executeDirective: async () => ({ kind: 'assembleReview', request: reviewRequest }),
    assembleReview: async (request) => {
      reviewCalls += 1;
      assertEqual(request, reviewRequest, 'RunEngine forwards the admitted review request unchanged');
      return reviewResult;
    },
  });

  const output = await engine.run({ sessionId: initialResult.session.id });
  assertEqual(output, reviewResult, 'RunEngine returns the assembled review result');
  assertEqual(initializeCalls, 1, 'review assembly does not initialize a second run');
  assertEqual(reviewCalls, 1, 'RunEngine assembles review exactly once');
}

export function assertProviderTurnSnapshotRecordsContextAdmissionShape(): void {
  const token = randomSmokeToken('provider-turn-snapshot');
  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `scope-${token}`,
    entries: [{
      id: `entry-${token}`,
      kind: 'file',
      label: `File ${token}`,
      resourceRef: `file-${token}.txt`,
      readPolicy: 'autoRead',
      reason: 'Read generic evidence.',
    }, {
      id: `dir-${token}`,
      kind: 'directory',
      label: `Directory ${token}`,
      resourceRef: `dir-${token}`,
      readPolicy: 'autoRead',
      reason: 'Read generic directory evidence.',
    }],
    budget: { maxEntries: 4, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  const initialContext = {
    id: `initial-${token}`,
    workspaceScopeKey: `scope-${token}`,
    manifest,
    roots: [{
      kind: 'directory' as const,
      rootId: `root-${token}`,
      label: `workspace-${token}`,
      displayPath: `workspace-${token}`,
      absolutePath: `/tmp/workspace-${token}`,
      source: 'currentAttachment' as const,
      primary: true,
    }],
  };
  const conversationRoots = initialContext.roots;
  const resourcePacket = createResourcePacket({
    packetId: `packet-${token}`,
    manifest,
    request: {
      id: `request-${token}`,
      items: [
        { id: `item-${token}`, manifestEntryId: `entry-${token}`, reason: 'Read generic evidence.' },
        { id: `dir-item-${token}`, manifestEntryId: `dir-${token}`, reason: 'Read generic directory evidence.' },
      ],
    },
    kernelEvidence: {
      [`entry-${token}`]: {
        contentKind: 'fileText',
        promptContent: `generic content ${token}`,
        evidenceRefs: [`evidence-${token}`],
      },
      [`dir-${token}`]: {
        contentKind: 'directoryTree',
        promptContent: `dir-${token}/\n  child-${token}.txt`,
        evidenceRefs: [`dir-evidence-${token}`],
      },
    },
  });
  const prompt = buildPromptEnvelope({
    workflowState: `workflow-${token}`,
    allowedProposals: ['actionBundle', 'resourceRequest'],
    capabilityCatalogSummary: `capability-${token}`,
    userRequest: `request-${token}`,
    resourcePromptContext: buildResourcePromptContext({
      initialContext,
      resourcePackets: [resourcePacket],
      conversationRoots,
    }),
  });
  const context = assembleContext({
    contextAssemblyId: `assembly-${token}`,
    workflowState: `workflow-${token}`,
    allowedProposals: ['actionBundle', 'resourceRequest'],
    capabilityCatalogSummary: `capability-${token}`,
    userRequest: `request-${token}`,
    initialContext,
    resourcePackets: [resourcePacket],
    conversationRoots,
  });
  const contract = new ContextFrameBuilder().buildSessionProviderTurnContract({
    contractId: `contract-${token}`,
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    allowedKinds: ['actionBundle', 'resourceRequest'],
    prompt,
    contextAssembly: context.contextAssembly,
    userRequest: `request-${token}`,
    acceptedPlanActive: true,
    currentTaskContext: {
      taskId: `task-${token}`,
      taskTitle: `Task ${token}`,
      goal: `Handle target ${token}`,
      targets: [`file-${token}.txt`, `dir-${token}/child-${token}.txt`],
      capabilities: ['fs.write'],
      taskOrder: [`task-${token}`],
      pendingTaskIds: [`task-${token}`],
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: [],
    },
    resourcePackets: [resourcePacket],
    generatedArtifactCount: 0,
    nextActionInstruction: `next-${token}`,
  });
  const accessFrame = contract.frames.find((frame) => frame.kind === 'AccessIndex');
  const accessSummary = accessFrame?.summary ?? '';
  const resourceFrame = contract.frames.find((frame) => frame.kind === 'ResourceEvidence');
  const resourceSummary = resourceFrame?.summary ?? '';
  assert(resourceSummary.includes('contentKinds=directoryTree=1,fileText=1'), 'provider turn resource evidence records resource content kind counts');
  assert(resourceSummary.includes('resourceBlockDetails=see AccessIndex frame'), 'provider turn resource evidence points detailed block reuse to access index');
  assert(accessSummary.includes(`ref=file-${token}.txt`), 'provider turn access index records resource identity');
  assert(accessSummary.includes('range=full-or-directory'), 'provider turn access index records resource range identity');
  assert(accessSummary.includes('use=file text is available'), 'provider turn access index records file text reuse instruction');
  assert(accessSummary.includes('use=directory inventory is available for existence checks and plan targets'), 'provider turn access index uses shared directory inventory reuse instruction');
  assert(accessSummary.includes(`currentTaskEvidence target=file-${token}.txt`), 'provider turn access index records current task target coverage');
  assert(accessSummary.includes(`currentTaskEvidence target=dir-${token}/child-${token}.txt`), 'provider turn access index records directory inventory target coverage');
  assert(accessSummary.includes('covered=true'), 'provider turn access index marks covered current task target');
  assert(accessSummary.includes('do not reread the same path/range'), 'provider turn access index discourages duplicate resource requests');
  const snapshot = buildProviderTurnSnapshot(contract);
  const accessSnapshotFrame = snapshot.frames.find((frame) => frame.kind === 'AccessIndex');
  assertEqual(snapshot.schemaVersion, 'deepcode.session.provider-turn-snapshot.v1', 'provider turn snapshot has schema version');
  assertEqual(snapshot.segmentOrder.length > 0, true, 'provider turn snapshot records segment order');
  assertEqual(snapshot.segments.every((segment) => segment.contentHash.length > 0), true, 'provider turn snapshot records segment hashes');
  assertEqual(snapshot.segments.every((segment) => typeof segment.charLength === 'number'), true, 'provider turn snapshot records segment lengths');
  assertEqual(
    snapshot.dynamicAppendLog.map((entry) => entry.name).join(','),
    context.contextAssembly.dynamicAppendLog.map((entry) => entry.name).join(','),
    'provider turn snapshot preserves context dynamic append log order'
  );
  assertEqual(snapshot.dynamicAppendLogHash, context.contextAssembly.dynamicAppendLogHash, 'provider turn snapshot preserves dynamic append log hash');
  assertEqual(snapshot.dynamicAppendLogCharLength, context.contextAssembly.dynamicAppendLogCharLength, 'provider turn snapshot preserves dynamic append log rendered length');
  assertEqual(snapshot.taskLocalFoldPlanHash, context.contextAssembly.taskLocalFoldPlanHash, 'provider turn snapshot preserves task-local fold plan hash');
  assertEqual(
    snapshot.taskLocalFoldPlan?.dynamicAppendLogHash,
    context.contextAssembly.dynamicAppendLogHash,
    'provider turn snapshot fold plan points to the same dynamic append log'
  );
  assertEqual(
    snapshot.taskLocalFoldPlan?.foldableSegmentCount,
    context.contextAssembly.taskLocalFoldPlan.foldableSegmentCount,
    'provider turn snapshot preserves foldable dynamic segment count'
  );
  assertEqual(
    snapshot.dynamicAppendLog.some((entry) => entry.foldPolicy === 'retainEvidenceHandle'),
    true,
    'provider turn snapshot preserves dynamic append fold policy'
  );
  assertEqual(Object.keys(snapshot.cacheClasses).length > 0, true, 'provider turn snapshot records cache classes');
  assertEqual(snapshot.frames.at(-1)?.kind, 'NextActionInstruction', 'provider turn snapshot records final next action frame');
  assertEqual(
    snapshot.frames.some((frame) => frame.kind === 'AccessIndex' && frame.summaryCharLength > 0),
    true,
    'provider turn snapshot records access index summary length'
  );
  assertEqual(accessSnapshotFrame?.currentTaskEvidenceLineCount, 2, 'provider turn snapshot records current task evidence line count');
  assertEqual(accessSnapshotFrame?.currentTaskEvidenceCoveredCount, 2, 'provider turn snapshot records covered current task evidence');
  assertEqual(accessSnapshotFrame?.currentTaskEvidenceUncoveredCount, 0, 'provider turn snapshot records uncovered current task evidence count');
  assertEqual(accessSnapshotFrame?.currentTaskEvidenceFullTextCount, 1, 'provider turn snapshot records full-text current task evidence');
  assertEqual(accessSnapshotFrame?.currentTaskEvidenceTargets.join(','), `dir-${token}/child-${token}.txt,file-${token}.txt`, 'provider turn snapshot records current task evidence target refs');
  assertEqual(accessSnapshotFrame?.currentTaskEvidenceMatchedRefs.join(','), `dir-${token},file-${token}.txt`, 'provider turn snapshot records current task evidence matched refs');
  assertEqual(snapshot.currentTaskEvidenceLineCount, 2, 'provider turn snapshot aggregates current task evidence line count');
  assertEqual(snapshot.currentTaskEvidenceCoveredCount, 2, 'provider turn snapshot aggregates covered current task evidence');
  assertEqual(snapshot.currentTaskEvidenceUncoveredCount, 0, 'provider turn snapshot aggregates uncovered current task evidence count');
  assertEqual(snapshot.currentTaskEvidenceFullTextCount, 1, 'provider turn snapshot aggregates full-text current task evidence');
  assertEqual(snapshot.currentTaskEvidenceTargets.join(','), `dir-${token}/child-${token}.txt,file-${token}.txt`, 'provider turn snapshot aggregates current task evidence target refs');
  assertEqual(snapshot.currentTaskEvidenceMatchedRefs.join(','), `dir-${token},file-${token}.txt`, 'provider turn snapshot aggregates current task evidence matched refs');
  assertEqual(
    snapshot.frames.every((frame) => frame.useCharLength > 0),
    true,
    'provider turn snapshot records frame use length'
  );
  assertEqual(
    snapshot.frames.every((frame) => typeof frame.dynamicUseOverlapCharLength === 'number' && typeof frame.dynamicSummaryOverlapCharLength === 'number'),
    true,
    'provider turn snapshot records dynamic overlap lengths per frame'
  );
  assertEqual(
    snapshot.frames.some((frame) => frame.kind === 'DynamicDialogue' && frame.dynamicSummaryOverlapCharLength > 0),
    true,
    'provider turn snapshot detects dynamic overlap for current user request frame'
  );
  assertEqual(snapshot.resourceBlocks.length > 0, true, 'provider turn snapshot records resource block metadata');
  assertEqual(snapshot.providerTurnContractHash.length > 0, true, 'provider turn snapshot records provider contract hash');
  assertEqual(typeof snapshot.dynamicFrameOverlapCharLength, 'number', 'provider turn snapshot records aggregate dynamic frame overlap length');
  assertEqual(typeof snapshot.dynamicFrameOverlapRatio, 'number', 'provider turn snapshot records aggregate dynamic frame overlap ratio');
  assertEqual(snapshot.dynamicDialogueSummaryCharLength > 0, true, 'provider turn snapshot records dynamic dialogue summary length');
  assertEqual(snapshot.dynamicDialogueDynamicSuffixOccurrences, 1, 'provider turn snapshot counts dynamic dialogue text in dynamic suffix');
  assertEqual(snapshot.dynamicDialogueFrameTextOccurrences >= 1, true, 'provider turn snapshot counts dynamic dialogue text in provider contract frames');
  assertEqual(snapshot.finalUserPromptHash.length > 0, true, 'provider turn snapshot records final user prompt hash');
  assertEqual(snapshot.finalUserPromptCharLength > snapshot.dynamicSuffixCharLength, true, 'provider turn snapshot records rendered contract appended to dynamic prompt');
  assertEqual(snapshot.semanticProfileId, 'execution-v1', 'provider turn snapshot records the stable semantic profile');
  assertEqual(snapshot.systemHash.length > 0, true, 'provider turn snapshot records the effective system hash');
  assertEqual(snapshot.toolSchemaHash.length > 0, true, 'provider turn snapshot records the stable tool schema hash');
  assertEqual(snapshot.responseFormatHash.length > 0, true, 'provider turn snapshot records the response shape hash');
  assertEqual(snapshot.messageShapeHash.length > 0, true, 'provider turn snapshot records the message shape hash');

  const finalUserPrompt = renderProviderTurnUserPrompt(contract.prompt.dynamicSuffix, contract);
  assertEqual(
    exactTextOccurrences(finalUserPrompt, `request-${token}`),
    1,
    'provider user prompt renders DynamicDialogue text once and references it from the contract'
  );
  assert(
    finalUserPrompt.includes('"dynamicContentIncludedOnce": true'),
    'provider user prompt records that dynamic content is rendered once'
  );
  assert(
    finalUserPrompt.includes('"frameOrder"'),
    'provider user prompt carries frame order without duplicating frame summaries'
  );
}

function exactTextOccurrences(source: string, needle: string): number {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

export function assertTaskLocalCompactRecordFlowsThroughCheckpoints(): void {
  const token = randomSmokeToken('task-compact');
  const context = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `accepted task ${token}`,
    currentTaskGoal: `write generic target ${token}`,
    currentTaskContext: {
      taskId: `task-${token}`,
      targets: [`generated/${token}.txt`],
    },
    taskCursor: {
      cursorId: `cursor-${token}`,
      lastSavepointId: `savepoint-${token}`,
    },
  });
  const compact = buildTaskLocalCompactRecord({
    contextAssembly: context.contextAssembly,
    source: 'kernelBatchCheckpoint',
    status: 'completedByKernelFacts',
    planId: `plan-${token}`,
    runId: `run-${token}`,
    taskId: `task-${token}`,
  });
  assert(compact, 'task-local compact record is produced from context assembly');
  if (!compact) throw new Error('task-local compact record setup failed');
  assertEqual(compact.boundary, 'sessionContextMetadataOnly', 'task-local compact record stays metadata-only');
  assertEqual(compact.dynamicAppendLogHash, context.contextAssembly.dynamicAppendLogHash, 'task-local compact record points to dynamic append log');
  assertEqual(compact.taskLocalFoldPlanHash, context.contextAssembly.taskLocalFoldPlanHash, 'task-local compact record points to fold plan');
  assertEqual(compact.foldablePolicies.includes('dropAfterTask'), true, 'task-local compact record preserves foldable policy');
  assertEqual(compact.compactHash.length > 0, true, 'task-local compact record has stable hash');

  const compactVariant = {
    ...compact,
    taskId: `task-variant-${token}`,
    compactHash: `compact-variant-${token}`,
  };
  const appended = appendTaskLocalCompactRecord([compact], compactVariant, 2);
  assertEqual(appended.length, 2, 'task-local compact record append preserves bounded history');
  const deduplicated = appendTaskLocalCompactRecord(appended, compact, 2);
  assertEqual(deduplicated.length, 2, 'task-local compact record append deduplicates repeated hashes');
  assertEqual(deduplicated.at(-1)?.compactHash, compact.compactHash, 'task-local compact record append keeps the newest record last');
  const limited = appendTaskLocalCompactRecord(deduplicated, {
    ...compact,
    taskId: `task-limited-${token}`,
    compactHash: `compact-limited-${token}`,
  }, 2);
  assertEqual(limited.length, 2, 'task-local compact record append evicts records beyond the limit');
  assertEqual(limited.some((record) => record.compactHash === compactVariant.compactHash), false, 'task-local compact record append evicts the oldest record');

  const accepted: AcceptedImplementationPlanContext = {
    planId: `plan-${token}`,
    runId: `run-${token}`,
    title: `Plan ${token}`,
    tasks: [{
      taskId: `task-${token}`,
      title: `Task ${token}`,
      targets: [`generated/${token}.txt`],
      capability: 'fs.write',
      dependencies: [],
      conflictKeys: [],
    }],
    capabilities: ['fs.write'],
    targetScopes: [`generated/${token}.txt`],
    exactOperationGrants: [],
    accessScopes: [],
    batchIndex: 0,
    completedTaskIds: [],
    rawPlan: {},
  };
  const builder = new SessionProgressProjectionBuilder({
    interactionOverlayPayload: () => ({}),
    hasFailureOrBlocker: () => false,
    auditAcceptedPlanBatch: () => ({}),
    actionBundleAdmissionBatch: () => ({}),
    acceptedPlanTaskLedger: (plan) => buildTaskLedgerSnapshot({
      planId: plan.planId,
      runId: plan.runId,
      tasks: plan.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        targets: task.targets,
        capability: task.capability,
      })),
      completedTaskIds: plan.completedTaskIds,
      modelJudgedSufficientTaskIds: plan.modelJudgedSufficientTaskIds ?? [],
    }),
    acceptedPlanPromptFrame: () => undefined,
  });
  const progress = {
    actionIds: [`action-${token}`],
    targetPaths: [`generated/${token}.txt`],
    workUnitIds: [`work-unit-${token}`],
    newlyCompletedTaskIds: [`task-${token}`],
    completedTaskIds: [`task-${token}`],
    remainingTaskIds: [],
  };
  const checkpoint = builder.acceptedPlanBatchCheckpointEvent(
    `session-${token}`,
    `run-${token}`,
    accepted,
    genericProposal(token, 'actionBundle'),
    [],
    progress,
    '2026-01-01T00:00:00.000Z',
    `checkpoint-${token}`,
    compact
  );
  const savepoint = builder.acceptedPlanTaskSavepointEvent(
    `session-${token}`,
    `run-${token}`,
    accepted,
    { ...accepted, completedTaskIds: [`task-${token}`] },
    progress,
    [],
    {
      cursorId: `cursor-${token}`,
      planId: `plan-${token}`,
      currentTaskId: `task-${token}`,
      taskOrder: [`task-${token}`],
      pendingTaskIds: [],
      completedTaskIds: [`task-${token}`],
      lastResourcePacketIds: [],
    },
    {
      goal: `write generic target ${token}`,
      taskId: `task-${token}`,
      targets: [`generated/${token}.txt`],
      capabilities: ['fs.write'],
      taskOrder: [`task-${token}`],
      pendingTaskIds: [],
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: [`task-${token}`],
    },
    '2026-01-01T00:00:00.000Z',
    `savepoint-${token}`,
    compact
  );
  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    entries: [{
      id: `entry-${token}`,
      kind: 'file',
      label: `File generated/${token}.txt`,
      resourceRef: `generated/${token}.txt`,
      readPolicy: 'autoRead',
      reason: 'Generic resource validation input.',
    }],
    budget: { maxEntries: 4, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  const packet = createResourcePacket({
    packetId: `packet-${token}`,
    manifest,
    request: {
      id: `request-${token}`,
      items: [{ id: `item-${token}`, manifestEntryId: `entry-${token}`, reason: 'Read generic resource.' }],
    },
    kernelEvidence: {
      [`entry-${token}`]: {
        contentKind: 'fileText',
        promptContent: `content ${token}`,
        evidenceRefs: [`evidence-${token}`],
      },
    },
  });
  const validationCheckpoint = builder.acceptedPlanResourceValidationCheckpointEvent(
    `session-${token}`,
    `run-${token}`,
    accepted,
    packet,
    {
      taskId: `task-${token}`,
      newlyCompletedTaskIds: [`task-${token}`],
      completedTaskIds: [`task-${token}`],
      remainingTaskIds: [],
      coveredTargets: [`generated/${token}.txt`],
    },
    '2026-01-01T00:00:00.000Z',
    `validation-checkpoint-${token}`,
    compact
  );
  assertEqual((checkpoint.payload as any).contextCompactRecord?.compactHash, compact.compactHash, 'batch checkpoint carries task-local compact record');
  assertEqual((savepoint.payload as any).contextCompactRecord?.compactHash, compact.compactHash, 'task savepoint carries task-local compact record');
  assertEqual((validationCheckpoint.payload as any).contextCompactRecord?.compactHash, compact.compactHash, 'resource validation checkpoint carries task-local compact record');

  const extracted = collectTaskLocalCompactRecords([checkpoint, savepoint, validationCheckpoint], {
    limit: 2,
    planId: `plan-${token}`,
  });
  assertEqual(extracted.length, 2, 'task-local compact extractor keeps recent checkpoint records');
  assertEqual(extracted.at(-1)?.compactHash, compact.compactHash, 'task-local compact extractor preserves compact hash');

  const previousTaskMarker = `previous task full text marker ${token}`;
  const decisionMarker = `preserve user decision marker ${token}`;
  const nextAssembly = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `next accepted task ${token}`,
    existingEvents: [
      {
        id: `previous-user-msg-${token}`,
        kind: 'user_msg',
        ts: '2026-01-01T00:00:00.000Z',
        payload: { content: `${previousTaskMarker} ${'detail '.repeat(80)}` },
      },
      {
        id: `previous-plan-review-${token}`,
        kind: 'plan_review',
        ts: '2026-01-01T00:00:01.000Z',
        payload: { status: 'accepted', guidance: decisionMarker },
      },
    ] as any,
    currentTaskGoal: `continue generic target ${token}`,
    currentTaskContext: {
      taskId: `next-task-${token}`,
      targets: [`generated/next-${token}.txt`],
    },
    taskLocalCompactRecords: extracted,
  });
  assertEqual(
    nextAssembly.prompt.dynamicSuffix.includes(previousTaskMarker),
    false,
    'task-local compaction folds previous task session-memory content out of provider-visible prompt'
  );
  assertEqual(
    nextAssembly.prompt.dynamicSuffix.includes('contentFolded=true'),
    true,
    'task-local compaction leaves a content-folded session-memory handle'
  );
  assertEqual(
    nextAssembly.prompt.dynamicSuffix.includes(decisionMarker),
    true,
    'task-local compaction preserves explicit user decisions'
  );
  const contract = new ContextFrameBuilder().buildSessionProviderTurnContract({
    contractId: `contract-${token}`,
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    allowedKinds: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    prompt: nextAssembly.prompt,
    contextAssembly: nextAssembly.contextAssembly,
    userRequest: `next accepted task ${token}`,
    acceptedPlanActive: true,
    currentTaskContext: {
      taskId: `next-task-${token}`,
      taskTitle: `Next task ${token}`,
      goal: `continue generic target ${token}`,
      targets: [`generated/next-${token}.txt`],
      capabilities: ['fs.write'],
      taskOrder: [`next-task-${token}`],
      pendingTaskIds: [`next-task-${token}`],
      dependsOn: [],
      evidenceNeeds: [],
      completedTaskIds: [],
    },
    resourcePackets: [],
    generatedArtifactCount: 0,
  });
  const snapshot = buildProviderTurnSnapshot(contract);
  assertEqual(nextAssembly.contextAssembly.taskLocalCompactRecordCount, extracted.length, 'ContextAdmission records task-local compact inputs');
  assertEqual(nextAssembly.contextAssembly.latestTaskLocalCompactHash, compact.compactHash, 'ContextAdmission exposes latest task-local compact hash');
  assertEqual(snapshot.taskLocalCompactRecordCount, extracted.length, 'provider snapshot records task-local compact count');
  assertEqual(snapshot.latestTaskLocalCompactHash, compact.compactHash, 'provider snapshot records latest task-local compact hash');

  const currentPath = `generated/current-${token}.txt`;
  const previousPath = `generated/previous-${token}.txt`;
  const foldManifest: ResourceManifest = {
    id: `fold-manifest-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    entries: [
      {
        id: `current-entry-${token}`,
        kind: 'file',
        label: `Current ${token}`,
        resourceRef: currentPath,
        readPolicy: 'autoRead',
        reason: 'Current task evidence.',
      },
      {
        id: `previous-entry-${token}`,
        kind: 'file',
        label: `Previous ${token}`,
        resourceRef: previousPath,
        readPolicy: 'autoRead',
        reason: 'Previous task evidence.',
      },
    ],
    budget: { maxEntries: 4, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  const foldPacket = createResourcePacket({
    packetId: `fold-packet-${token}`,
    manifest: foldManifest,
    request: {
      id: `fold-request-${token}`,
      items: [
        { id: `current-item-${token}`, manifestEntryId: `current-entry-${token}`, reason: 'Read current task evidence.' },
        { id: `previous-item-${token}`, manifestEntryId: `previous-entry-${token}`, reason: 'Read previous task evidence.' },
      ],
    },
    kernelEvidence: {
      [`current-entry-${token}`]: {
        contentKind: 'fileText',
        promptContent: `current full text ${token}`,
        evidenceRefs: [`current-evidence-${token}`],
      },
      [`previous-entry-${token}`]: {
        contentKind: 'fileText',
        promptContent: `previous full text ${token}`,
        evidenceRefs: [`previous-evidence-${token}`],
      },
    },
  });
  const foldedAssembly = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `folded next task ${token}`,
    initialContext: {
      id: `fold-context-${token}`,
      workspaceScopeKey: `workspace-${token}`,
      manifest: foldManifest,
    },
    resourcePackets: [foldPacket],
    currentTaskContext: {
      taskId: `current-task-${token}`,
      targets: [currentPath],
    },
    taskLocalCompactRecords: [compact],
  });
  const currentBlock = foldedAssembly.contextAssembly.resourceBlocks.find((block) => block.displayRef === currentPath);
  const previousBlock = foldedAssembly.contextAssembly.resourceBlocks.find((block) => block.displayRef === previousPath);
  assertEqual(currentBlock?.retention, 'full', 'task-local compaction keeps current task target full text');
  assertEqual(previousBlock?.retention, 'summary', 'task-local compaction folds non-current task full text to summary');

  const workspaceRoot = `/workspace-${token}`;
  const absoluteTargetAssembly = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `absolute target ${token}`,
    initialContext: {
      id: `absolute-target-context-${token}`,
      workspaceScopeKey: `workspace-${token}`,
      manifest: foldManifest,
    },
    conversationRoots: [{
      rootId: `root-${token}`,
      kind: 'directory',
      label: `Root ${token}`,
      displayPath: workspaceRoot,
      absolutePath: workspaceRoot,
      source: 'workspaceBinding',
      primary: true,
    }],
    resourcePackets: [foldPacket],
    currentTaskContext: {
      taskId: `absolute-target-task-${token}`,
      targets: [`${workspaceRoot}/${currentPath}`],
    },
    taskLocalCompactRecords: [compact],
  });
  const absoluteTargetCurrentBlock = absoluteTargetAssembly.contextAssembly.resourceBlocks.find((block) => block.displayRef === currentPath);
  const absoluteTargetPreviousBlock = absoluteTargetAssembly.contextAssembly.resourceBlocks.find((block) => block.displayRef === previousPath);
  assertEqual(absoluteTargetCurrentBlock?.retention, 'full', 'task-local compaction matches absolute task targets to relative resource references');
  assertEqual(absoluteTargetPreviousBlock?.retention, 'summary', 'task-local compaction still folds unrelated resources for an absolute task target');

  const requestedDependencyAssembly = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `requested dependency ${token}`,
    initialContext: {
      id: `requested-dependency-context-${token}`,
      workspaceScopeKey: `workspace-${token}`,
      manifest: foldManifest,
    },
    resourcePackets: [foldPacket],
    currentTaskContext: {
      taskId: `requested-dependency-task-${token}`,
      targets: [`generated/new-${token}.txt`],
    },
    currentTaskResourcePacketIds: [foldPacket.id],
    taskLocalCompactRecords: [compact],
  });
  const requestedDependencyBlock = requestedDependencyAssembly.contextAssembly.resourceBlocks.find((block) => block.displayRef === previousPath);
  assertEqual(requestedDependencyBlock?.retention, 'full', 'task-local compaction keeps a dependency packet explicitly requested by the current task');

  const noTargetAssembly = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `no explicit target ${token}`,
    initialContext: {
      id: `no-target-context-${token}`,
      workspaceScopeKey: `workspace-${token}`,
      manifest: foldManifest,
    },
    resourcePackets: [foldPacket],
    currentTaskContext: {
      taskId: `no-target-task-${token}`,
    },
    taskLocalCompactRecords: [compact],
  });
  const noTargetPreviousBlock = noTargetAssembly.contextAssembly.resourceBlocks.find((block) => block.displayRef === previousPath);
  assertEqual(noTargetPreviousBlock?.retention, 'full', 'task-local compaction does not fold full text when current task targets are unavailable');
}

export async function assertProviderTurnContextCoordinatorPassesTaskLocalCompactRecords(): Promise<void> {
  const token = randomSmokeToken('provider-context-compact');
  const previous = assembleContext({
    workflowState: 'acceptedTaskExecution',
    allowedProposals: ['actionBundle', 'resourceRequest', 'taskOutcome', 'diagnostic'],
    capabilityCatalogSummary: 'fs.write',
    userRequest: `previous task ${token}`,
    currentTaskGoal: `write previous target ${token}`,
    currentTaskContext: {
      taskId: `task-${token}`,
      targets: [`generated/${token}.txt`],
    },
  });
  const compact = buildTaskLocalCompactRecord({
    contextAssembly: previous.contextAssembly,
    source: 'modelTaskOutcome',
    status: 'modelJudgedSufficient',
    planId: `plan-${token}`,
    runId: `run-${token}`,
    taskId: `task-${token}`,
  });
  assert(compact, 'provider context compact setup produced compact record');
  if (!compact) throw new Error('provider context compact setup failed');
  let capturedCompactHash: string | undefined;
  const coordinator = new ProviderTurnContextCoordinator<any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    assembleContext: (input) => {
      capturedCompactHash = input.taskLocalCompactRecords?.at(-1)?.compactHash;
      return assembleContext({
        ...input,
        contextAssemblyId: `assembly-${token}`,
      });
    },
    allowedProposals: (allowed) => allowed,
    capabilityCatalogSummary: () => `capability-${token}`,
    memoryHints: () => [],
    collectUserGuidanceEvents: () => [],
    appendConsumedGuidance: async ({ result }) => result,
    buildProviderTurnContract: (input) =>
      new ContextFrameBuilder().buildSessionProviderTurnContract({
        contractId: input.contractId,
        sessionId: input.sessionId,
        runId: input.runId,
        allowedKinds: input.allowedKinds,
        prompt: input.prompt,
        contextAssembly: input.contextAssembly,
        userRequest: input.userRequest,
        confirmedDecisionSummary: input.confirmedDecisionSummary,
        acceptedPlanActive: input.acceptedPlanActive,
        currentTaskContext: input.currentTaskContext,
        resourcePackets: input.resourcePackets,
        generatedArtifactCount: input.generatedArtifactCount,
        toolIntentTemplates: input.toolIntentTemplates,
        nextActionInstruction: input.nextActionInstruction,
      }),
  });

  const result = await coordinator.prepare({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `original request ${token}`,
    stateContract: {
      stateId: `state-${token}`,
      allowedProposals: ['resourceRequest', 'actionBundle', 'taskOutcome', 'diagnostic'],
    },
    acceptedImplementationPlan: {
      planId: `plan-${token}`,
      runId: `run-${token}`,
      tasks: [],
    },
    currentTaskContext: {
      taskId: `next-task-${token}`,
      taskTitle: `Next task ${token}`,
      goal: `continue generic target ${token}`,
      targets: [`generated/next-${token}.txt`],
    },
    taskLocalCompactRecords: [compact],
    memoryDocument: buildSessionMemoryDocument([]),
    resourcePackets: [],
    conversationRoots: [],
    generatedArtifactEvidence: new Map(),
  }, {
    contextAssemblyId: `requested-${token}`,
    contractId: `contract-${token}`,
    inputContent: `input ${token}`,
    lastResult: genericSessionResult(`session-${token}`),
  });

  assertEqual(capturedCompactHash, compact.compactHash, 'provider context coordinator passes task-local compact records into ContextAdmission');
  assertEqual(result.modelContextBundle.contextAssembly?.taskLocalCompactRecordCount, 1, 'model context bundle records task-local compact count');
  assertEqual(result.modelContextBundle.snapshot.latestTaskLocalCompactHash, compact.compactHash, 'provider snapshot keeps task-local compact hash from coordinator state');
}

export async function assertProviderTurnContextCoordinatorUsesFreshAssembly(): Promise<void> {
  const token = randomSmokeToken('provider-context-fresh');
  const stale = assembleContext({
    contextAssemblyId: `stale-${token}`,
    workflowState: `workflow-stale-${token}`,
    allowedProposals: ['answer'],
    capabilityCatalogSummary: `capability-stale-${token}`,
    userRequest: `stale request ${token}`,
  });
  const fresh = assembleContext({
    contextAssemblyId: `fresh-${token}`,
    workflowState: `workflow-fresh-${token}`,
    allowedProposals: ['answer'],
    capabilityCatalogSummary: `capability-fresh-${token}`,
    userRequest: `fresh request ${token}`,
  });
  let contractAssemblyId: string | undefined;
  const coordinator = new ProviderTurnContextCoordinator<any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    assembleContext: () => fresh,
    allowedProposals: (allowed) => allowed,
    capabilityCatalogSummary: () => `capability-${token}`,
    memoryHints: () => [],
    collectUserGuidanceEvents: () => [],
    appendConsumedGuidance: async ({ result }) => result,
    buildProviderTurnContract: (input) => {
      contractAssemblyId = input.contextAssembly?.contextAssemblyId;
      return new ContextFrameBuilder().buildSessionProviderTurnContract({
        contractId: input.contractId,
        sessionId: input.sessionId,
        runId: input.runId,
        allowedKinds: input.allowedKinds,
        prompt: input.prompt,
        contextAssembly: input.contextAssembly,
        userRequest: input.userRequest,
        confirmedDecisionSummary: input.confirmedDecisionSummary,
        acceptedPlanActive: input.acceptedPlanActive,
        currentTaskContext: input.currentTaskContext,
        resourcePackets: input.resourcePackets,
        generatedArtifactCount: input.generatedArtifactCount,
        toolIntentTemplates: input.toolIntentTemplates,
        nextActionInstruction: input.nextActionInstruction,
      });
    },
  });

  const result = await coordinator.prepare({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `original request ${token}`,
    stateContract: {
      stateId: `state-${token}`,
      allowedProposals: ['answer'],
    },
    memoryDocument: buildSessionMemoryDocument([]),
    resourcePackets: [],
    conversationRoots: [],
    generatedArtifactEvidence: new Map(),
    contextAssembly: stale.contextAssembly,
  }, {
    contextAssemblyId: `requested-${token}`,
    contractId: `contract-${token}`,
    inputContent: `input ${token}`,
    lastResult: genericSessionResult(`session-${token}`),
  });

  assertEqual(contractAssemblyId, fresh.contextAssembly.contextAssemblyId, 'provider turn contract uses the freshly assembled context');
  assertEqual(result.modelContextBundle.contextAssembly?.contextAssemblyId, fresh.contextAssembly.contextAssemblyId, 'model context bundle keeps the same fresh context');
  assertEqual(result.modelContextBundle.providerTurnContract.contextAssembly?.contextAssemblyId, fresh.contextAssembly.contextAssemblyId, 'provider turn frame keeps the same fresh context');
  assertEqual(result.modelContextBundle.providerTurnContract.contextAssembly?.contextAssemblyId === stale.contextAssembly.contextAssemblyId, false, 'stale state context assembly does not overwrite the current admission');
}

export async function assertProviderTurnContextCoordinatorNarrowsPlanningAllowedKinds(): Promise<void> {
  const token = randomSmokeToken('provider-context-allowed');
  let assembledAllowed: string[] = [];
  let contractAllowed: string[] = [];
  const coordinator = new ProviderTurnContextCoordinator<any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    assembleContext: (input) => {
      assembledAllowed = [...input.allowedProposals];
      return assembleContext({
        ...input,
        contextAssemblyId: `assembly-${token}`,
      });
    },
    allowedProposals: (allowed) => allowed,
    capabilityCatalogSummary: () => `capability-${token}`,
    memoryHints: () => [],
    collectUserGuidanceEvents: () => [],
    appendConsumedGuidance: async ({ result }) => result,
    buildProviderTurnContract: (input) => {
      contractAllowed = [...input.allowedKinds];
      return new ContextFrameBuilder().buildSessionProviderTurnContract({
        contractId: input.contractId,
        sessionId: input.sessionId,
        runId: input.runId,
        allowedKinds: input.allowedKinds,
        prompt: input.prompt,
        contextAssembly: input.contextAssembly,
        userRequest: input.userRequest,
        confirmedDecisionSummary: input.confirmedDecisionSummary,
        acceptedPlanActive: input.acceptedPlanActive,
        currentTaskContext: input.currentTaskContext,
        resourcePackets: input.resourcePackets,
        generatedArtifactCount: input.generatedArtifactCount,
        toolIntentTemplates: input.toolIntentTemplates,
        nextActionInstruction: input.nextActionInstruction,
      });
    },
  });

  const result = await coordinator.prepare({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `request ${token}`,
    stateContract: {
      stateId: `state-${token}`,
      allowedProposals: ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'actionBundle', 'taskOutcome', 'diagnostic'],
    },
    memoryDocument: buildSessionMemoryDocument([]),
    resourcePackets: [],
    conversationRoots: [],
    generatedArtifactEvidence: new Map(),
  }, {
    contextAssemblyId: `requested-${token}`,
    contractId: `contract-${token}`,
    inputContent: `input ${token}`,
    lastResult: genericSessionResult(`session-${token}`),
  });

  assertEqual(assembledAllowed.includes('actionBundle'), false, 'planning ContextAdmission does not expose actionBundle');
  assertEqual(assembledAllowed.includes('taskOutcome'), false, 'planning ContextAdmission does not expose taskOutcome');
  assertEqual(contractAllowed.includes('actionBundle'), false, 'planning provider contract does not expose actionBundle');
  assertEqual(result.allowedProposals.includes('actionBundle'), false, 'planning result allowed proposals are provider-visible only');
  assertEqual(result.modelContextBundle.providerTurnContract.allowedKinds.includes('taskPlan'), true, 'planning still allows taskPlan');
}

export async function assertProviderTurnContextCoordinatorScopesAcceptedExecutionCatalog(): Promise<void> {
  const token = randomSmokeToken('provider-context-scoped-catalog');
  const fullCatalogMarker = `FULL_TOOL_CATALOG_SHOULD_NOT_APPEAR_${token}`;
  let assemblyCapabilitySummary = '';
  const baseCatalog = genericToolCatalogSnapshot() as any;
  const scopedCatalog = {
    ...baseCatalog,
    tools: [
      ...baseCatalog.tools,
      {
        toolId: 'process.exec',
        capability: 'process.exec',
        family: 'process',
        risk: 'high',
        permissionMode: 'ask',
        pathScopePolicy: 'none',
        executionMode: 'blocked',
        needsWorkspace: false,
        readOnly: false,
        operationKind: 'exec',
        providerSchema: {
          type: 'object',
          properties: { argv: { type: 'array', items: { type: 'string' } } },
          required: ['argv'],
        },
      },
    ],
  };
  const coordinator = new ProviderTurnContextCoordinator<any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    assembleContext: (input) => {
      assemblyCapabilitySummary = input.capabilityCatalogSummary;
      return assembleContext({
        ...input,
        contextAssemblyId: `assembly-${token}`,
      });
    },
    allowedProposals: (allowed) => allowed,
    capabilityCatalogSummary: () => fullCatalogMarker,
    memoryHints: () => [],
    collectUserGuidanceEvents: () => [],
    appendConsumedGuidance: async ({ result }) => result,
    buildProviderTurnContract: (input) => new ContextFrameBuilder().buildSessionProviderTurnContract({
      contractId: input.contractId,
      sessionId: input.sessionId,
      runId: input.runId,
      allowedKinds: input.allowedKinds,
      prompt: input.prompt,
      contextAssembly: input.contextAssembly,
      userRequest: input.userRequest,
      confirmedDecisionSummary: input.confirmedDecisionSummary,
      acceptedPlanActive: input.acceptedPlanActive,
      currentTaskContext: input.currentTaskContext,
      resourcePackets: input.resourcePackets,
      generatedArtifactCount: input.generatedArtifactCount,
      toolIntentTemplates: input.toolIntentTemplates,
      nextActionInstruction: input.nextActionInstruction,
    }),
  });

  const result = await coordinator.prepare({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `request ${token}`,
    stateContract: {
      stateId: `state-${token}`,
      allowedProposals: ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'implementationPlan', 'actionBundle', 'taskOutcome', 'diagnostic'],
      toolCatalogSnapshot: scopedCatalog,
    },
    memoryDocument: buildSessionMemoryDocument([]),
    resourcePackets: [],
    conversationRoots: [],
    generatedArtifactEvidence: new Map(),
    acceptedImplementationPlan: {
      planId: `plan-${token}`,
      runId: `run-${token}`,
      title: `Plan ${token}`,
      summary: `Summary ${token}`,
      tasks: [{
        taskId: `task-${token}`,
        title: `Task ${token}`,
        capability: 'fs.write',
        targets: [`target-${token}.txt`],
        dependencies: [],
        conflictKeys: [],
      }],
      capabilities: ['fs.write'],
      targetScopes: [`target-${token}.txt`],
      exactOperationGrants: [{
        operation: 'write',
        targetPath: `target-${token}.txt`,
        targetResourceKind: 'file',
        capability: 'fs.write',
        sourceTaskId: `task-${token}`,
        source: 'kernelPlanReview',
      }],
      accessScopes: [],
      batchIndex: 1,
      completedTaskIds: [],
      rawPlan: {},
    },
    currentTaskContext: {
      taskId: `task-${token}`,
      taskTitle: `Task ${token}`,
      goal: `Handle ${token}`,
      targets: [`target-${token}.txt`],
      capabilities: ['fs.write', 'process.exec'],
    },
  }, {
    contextAssemblyId: `requested-${token}`,
    contractId: `contract-${token}`,
    inputContent: `input ${token}`,
    lastResult: genericSessionResult(`session-${token}`),
  });
  const dynamicPrompt = result.modelContextBundle.prompt.dynamicSuffix;
  const renderedContract = JSON.stringify(result.modelContextBundle.providerTurnContract);
  const expectedExecutionKinds = ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic'];

  assertEqual(result.allowedProposals.join(','), expectedExecutionKinds.join(','), 'accepted execution exposes only execution proposal kinds');
  assertEqual(result.modelContextBundle.providerTurnContract.allowedKinds.join(','), expectedExecutionKinds.join(','), 'accepted execution provider contract ignores stale planning and answer kinds');
  assert(result.modelContextBundle.prompt.stablePrefix.includes('Session semantic profile: execution-v1'), 'accepted execution selects the stable execution semantic profile');
  assert(result.modelContextBundle.prompt.stablePrefix.includes('ProtectedStablePrefix begins here.'), 'accepted execution preserves the ContextAdmission stable contract in the provider system message');
  assertEqual(
    result.modelContextBundle.contextAssembly?.providerCacheAttribution.cacheEligiblePrefixCharLength,
    result.modelContextBundle.prompt.stablePrefix.length,
    'ContextAdmission cache attribution measures the physical provider system prefix'
  );
  assert(result.modelContextBundle.contextAssembly?.segments.some((segment) => segment.name === 'providerProfileContract'), 'ContextAdmission records the provider profile as a stable segment');
  assert(!dynamicPrompt.includes('Execution uses provider-native Session semantic tools'), 'accepted execution dynamic prompt does not repeat the semantic tool profile');
  assertEqual(dynamicPrompt.includes('session.submit_answer'), false, 'accepted execution prompt does not expose planning answer tools');
  assertEqual(assemblyCapabilitySummary.includes(fullCatalogMarker), false, 'accepted execution does not pass the full capability catalog into ContextAdmission');
  assert(assemblyCapabilitySummary.includes('Accepted execution Session directive summary.'), 'accepted execution passes a scoped Session directive summary');
  assert(assemblyCapabilitySummary.includes(`slotId=slot-task-${token}-1`), 'scoped summary records the current IntentSlot');
  assert(assemblyCapabilitySummary.includes(`targetRef=target-${token}.txt`), 'scoped summary records current slot target ownership');
  assertEqual(assemblyCapabilitySummary.includes('toolId='), false, 'scoped summary does not expose internal tool ids');
  assertEqual(dynamicPrompt.includes(fullCatalogMarker), false, 'accepted execution dynamic prompt does not expose full capability catalog');
  assertEqual(renderedContract.includes(fullCatalogMarker), false, 'accepted execution provider contract does not expose full capability catalog');
  assertEqual(renderedContract.includes('browser.click'), false, 'accepted execution provider contract does not enumerate unrelated Kernel catalog tool ids');
  assertEqual(renderedContract.includes('"toolId"'), false, 'accepted execution provider contract does not expose Kernel tool ids');
  assert(
    renderedContract.includes('IntentSlot'),
    'accepted execution contract exposes current IntentSlot metadata'
  );
  assert(dynamicPrompt.includes('Current accepted task IntentSlot scope:'), 'accepted execution workflow state labels IntentSlot scope');
}

export async function assertProviderTurnContextCoordinatorFiltersUnscopedGrantsToCurrentTask(): Promise<void> {
  const token = randomSmokeToken('provider-context-current-task-grants');
  const currentTarget = `Current-${randomSmokeToken('file')}/CaseFile-${randomSmokeToken('target')}.TXT`;
  const futureTarget = `future-${randomSmokeToken('file')}.txt`;
  let assemblyCapabilitySummary = '';
  const coordinator = new ProviderTurnContextCoordinator<any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    assembleContext: (input) => {
      assemblyCapabilitySummary = input.capabilityCatalogSummary;
      return assembleContext({
        ...input,
        contextAssemblyId: `assembly-${token}`,
      });
    },
    allowedProposals: (allowed) => allowed,
    capabilityCatalogSummary: () => `full-catalog-${token}`,
    memoryHints: () => [],
    collectUserGuidanceEvents: () => [],
    appendConsumedGuidance: async ({ result }) => result,
    buildProviderTurnContract: (input) => new ContextFrameBuilder().buildSessionProviderTurnContract({
      contractId: input.contractId,
      sessionId: input.sessionId,
      runId: input.runId,
      allowedKinds: input.allowedKinds,
      prompt: input.prompt,
      contextAssembly: input.contextAssembly,
      userRequest: input.userRequest,
      confirmedDecisionSummary: input.confirmedDecisionSummary,
      acceptedPlanActive: input.acceptedPlanActive,
      currentTaskContext: input.currentTaskContext,
      resourcePackets: input.resourcePackets,
      generatedArtifactCount: input.generatedArtifactCount,
      toolIntentTemplates: input.toolIntentTemplates,
      nextActionInstruction: input.nextActionInstruction,
    }),
  });

  const result = await coordinator.prepare({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `request ${token}`,
    stateContract: {
      stateId: `state-${token}`,
      allowedProposals: ['resourceRequest', 'actionBundle', 'taskOutcome', 'diagnostic'],
      toolCatalogSnapshot: genericToolCatalogSnapshot() as any,
    },
    memoryDocument: buildSessionMemoryDocument([]),
    resourcePackets: [],
    conversationRoots: [],
    generatedArtifactEvidence: new Map(),
    acceptedImplementationPlan: {
      planId: `plan-${token}`,
      runId: `run-${token}`,
      title: `Plan ${token}`,
      summary: `Summary ${token}`,
      tasks: [
        { taskId: `task-current-${token}`, targets: [currentTarget], dependencies: [], conflictKeys: [] },
        { taskId: `task-future-${token}`, targets: [futureTarget], dependencies: [], conflictKeys: [] },
      ],
      capabilities: ['fs.write'],
      targetScopes: [currentTarget, futureTarget],
      completedTaskIds: [],
      exactOperationGrants: [
        {
          operation: 'fs.write',
          capability: 'fs.write',
          targetPath: currentTarget,
          source: 'kernelPlanReview',
        },
        {
          operation: 'fs.write',
          capability: 'fs.write',
          targetPath: futureTarget,
          source: 'kernelPlanReview',
        },
      ],
      accessScopes: [],
      batchIndex: 1,
      rawPlan: {},
    },
    currentTaskContext: {
      taskId: `task-current-${token}`,
      taskTitle: `Current task ${token}`,
      goal: `Write only current target ${token}`,
      targets: [currentTarget],
      capabilities: ['fs.write'],
    },
  }, {
    contextAssemblyId: `requested-${token}`,
    contractId: `contract-${token}`,
    inputContent: `input ${token}`,
    lastResult: genericSessionResult(`session-${token}`),
  });

  const contract = result.modelContextBundle.providerTurnContract;
  const renderedContract = JSON.stringify(contract);
  assert(assemblyCapabilitySummary.includes(`targetRef=${currentTarget}`), 'current task scoped grant remains visible as an IntentSlot');
  assertEqual(assemblyCapabilitySummary.includes(futureTarget), false, 'future task unscoped grant is hidden from current task summary');
  assert(renderedContract.includes(currentTarget), 'provider contract keeps the current target template');
  assertEqual(renderedContract.includes(futureTarget), false, 'provider contract does not expose future task target templates');
  assertEqual(contract.toolIntentTemplates.length, 1, 'only current task matching unscoped grant becomes an IntentSlot');
  assertEqual(
    contract.toolIntentTemplates[0]?.targets[0],
    currentTarget,
    'current task IntentSlot target is exact'
  );
  assertEqual((contract.toolIntentTemplates[0]?.template as any)?.contentMode, 'full', 'current write slot declares full-content mode');
}

export async function assertRequirementConfirmationRecordsModelContextBundle(): Promise<void> {
  const token = randomSmokeToken('requirement-context');
  const state: any = {
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    memoryDocument: buildSessionMemoryDocument([]),
    memoryHints: [],
    resourcePackets: [],
    conversationRoots: [],
    generatedArtifactEvidence: new Map(),
  };
  const coordinator = new RequirementConfirmationCoordinator<any, any>({
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${token}`,
    assembleContext: (input) => assembleContext(input),
    capabilityCatalogSummary: () => `catalog-${token}`,
    collectUserGuidanceEvents: () => [],
    buildProviderTurnContract: (input) =>
      new ContextFrameBuilder().buildSessionProviderTurnContract(input),
    callProviderAndParse: async (_input, observedState) => {
      assertEqual(
        observedState.providerTurnFrame?.snapshot?.turnMode,
        'requirementDecision',
        'requirement decision provider frame carries its snapshot before the provider call'
      );
      assertEqual(
        observedState.modelContextBundle?.snapshot?.turnMode,
        'requirementDecision',
        'requirement decision records a model context bundle before the provider call'
      );
      assertEqual(
        observedState.modelContextBundle?.providerTurnContract.allowedKinds.join(','),
        'decisionRequest',
        'requirement decision model context exposes only decisionRequest'
      );
      return genericProposal(token, 'decisionRequest');
    },
    createError: (_code, message) => new Error(message),
    requirementRecordFromProposal: ({ userRequest }) => ({
      requirementId: `requirement-${token}`,
      sessionId: state.sessionId,
      status: 'probing',
      initialUserRequest: userRequest,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    confirmationEvent: (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'requirement_confirmation',
      payload: {
        runId: input.runId,
        requirementId: input.requirement.requirementId,
        status: input.requirement.status,
      },
    }),
    executionRootPayload: () => undefined,
  });

  const event = await coordinator.build({
    sessionId: state.sessionId,
    content: `request ${token}`,
    requirementConfirmationMode: 'always',
  }, state);

  assertEqual(event.kind, 'requirement_confirmation', 'requirement decision still emits the confirmation event');
  assertEqual(
    state.contextAssembly?.contextAssemblyId,
    state.modelContextBundle?.contextAssembly?.contextAssemblyId,
    'requirement decision model context uses the current ContextAdmission assembly'
  );
  assertEqual(
    state.providerTurnFrame?.snapshot?.finalUserPromptCharLength > 0,
    true,
    'requirement decision snapshot records the final provider-visible prompt length'
  );
  assertEqual(
    state.providerTurnFrame?.frames.at(-1)?.kind,
    'NextActionInstruction',
    'requirement decision keeps NextActionInstruction as the final frame'
  );
}

export async function assertHookObserverProducesTraceOnly(): Promise<void> {
  const token = randomSmokeToken('hook-observer');
  const registry = new HookRegistry();
  registry.register({
    id: `hook-${token}`,
    type: 'observer',
    run: async (input) => ({
      status: 'ok',
      effects: [{
        kind: 'appendTrace',
        data: {
          point: input.point,
          contractId: input.contractId,
        },
      }],
    }),
  });
  const runtime = new HookRuntime(registry, HookPolicy.observerOnly());
  const blockedRuntime = new HookRuntime(registry);
  const denied = await blockedRuntime.run({
    point: 'contextAdmission.after',
    sessionId: `session-${token}`,
  });
  assertEqual(denied.length, 0, 'hook policy denies observer hooks by default');
  const results = await runtime.run({
    point: 'providerCall.before',
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    contractId: `contract-${token}`,
    allowedKinds: ['answer'],
  });
  assertEqual(results.length, 1, 'observer hook runs at providerCall.before');
  assertEqual(results[0]?.status, 'ok', 'observer hook returns trace result');
  assertEqual(results[0]?.status === 'ok' && results[0].effects?.[0]?.kind, 'appendTrace', 'observer hook effect is trace-only');
}
