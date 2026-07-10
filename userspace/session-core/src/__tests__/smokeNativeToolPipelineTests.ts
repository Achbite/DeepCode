import type {
  AgentEvent,
  LlmChatRequest,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceManifest, ResourcePacket } from '../index.js';
import {
  NativeToolExposurePolicy,
  NativeToolHandlerPortsFactory,
  NativeToolProgressEventBuilder,
  NativeToolProviderLoop,
  NativeToolProjectionBuilder,
  NativeToolRepairCoordinator,
  NativeToolRepairRunner,
  NativeToolResourceRecorder,
  NativeToolResultMessageBuilder,
  NativeToolResumeMessageBuilder,
  ProposalOnlyProviderRunner,
} from '../driver/pipelines/index.js';
import { assert, assertEqual, randomSmokeToken } from './smokeHelpers.js';

export function assertNativeToolRepairCoordinatorBuildsRepairContracts(): void {
  const token = randomSmokeToken('native-repair');
  const runId = `run-${token}`;
  const sessionId = `session-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('target')}.txt`;
  let repairedAllowedKinds: string[] = [];
  let parseProposalRaw = '';
  const coordinator = new NativeToolRepairCoordinator({
    conversationActivity: (input) => ({
      activityId: input.activityId,
      kind: input.kind,
      status: input.status,
      title: input.title,
      summary: input.summary,
      source: input.source,
      runId: input.runId,
      toolName: input.toolName,
      targets: input.targets,
    }),
    parseProposal: (input) => {
      parseProposalRaw = input.raw;
      return { kind: 'diagnostic', runId: input.runId } as unknown as ProposalEnvelope;
    },
    parseRepairedProposal: (input) => {
      repairedAllowedKinds = input.allowedKinds;
      return { kind: input.allowedKinds[0], sessionId: input.sessionId } as unknown as ProposalEnvelope;
    },
  });
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: targetPath },
  };
  const sideEffectDelta = coordinator.sideEffectBlockedDelta({ sessionId, runId, toolCall });
  assertEqual(sideEffectDelta.stage, 'native_tool_side_effect_blocked', 'native tool repair coordinator builds side-effect delta stage');
  assertEqual((sideEffectDelta.payload as any).callId, toolCall.callId, 'native tool repair coordinator carries blocked call id');
  assertEqual(coordinator.sideEffectAllowedKinds(true)[0], 'actionBundle', 'native tool repair coordinator allows actionBundle in accepted execution');
  assertEqual(coordinator.sideEffectAllowedKinds(false)[0], 'decisionRequest', 'native tool repair coordinator avoids actionBundle outside accepted execution');
  const proposalOnlyDelta = coordinator.proposalOnlyToolViolationDelta({
    sessionId,
    runId,
    stage: `stage-${token}`,
    acceptedPlanId: `plan-${token}`,
    toolCall,
  });
  assertEqual(proposalOnlyDelta.stage, 'accepted_plan.provider_tool_violation', 'native tool repair coordinator builds proposal-only violation stage');
  assertEqual((proposalOnlyDelta.payload as any).acceptedPlanId, `plan-${token}`, 'native tool repair coordinator carries accepted plan id');

  const duplicate = {
    toolCall,
    signature: { key: `sig-${token}`, toolName: toolCall.name, path: targetPath, kind: 'file' as const },
    entry: {
      signature: { key: `sig-${token}`, toolName: toolCall.name, path: targetPath, kind: 'file' as const },
      packet: {
        id: `packet-${token}`,
        requestId: `request-${token}`,
        workspaceScopeKey: `scope-${token}`,
        items: [],
      },
      contentHash: `hash-${token}`,
      repeatCount: 2,
    },
  };
  const duplicateDelta = coordinator.duplicateRepairDelta({ sessionId, runId, duplicates: [duplicate] });
  assertEqual(duplicateDelta.stage, 'native_tool_duplicate_repair', 'native tool repair coordinator builds duplicate repair stage');
  assertEqual((duplicateDelta.activity as any).targets[0], targetPath, 'native tool repair coordinator carries duplicate target path');
  assert(coordinator.duplicateLoopError([duplicate]).message.includes(targetPath), 'native tool repair coordinator reports duplicate loop target');

  assertEqual(coordinator.parseTurnProposal({ turn: { content: 'not-json' }, runId, sessionId }), null, 'native tool repair coordinator ignores non-json turn content');
  assertEqual(coordinator.parseTurnProposal({ turn: { content: '{"kind":"diagnostic"}' }, runId, sessionId })?.kind, 'diagnostic', 'native tool repair coordinator parses json turn proposal');
  assertEqual(parseProposalRaw, '{"kind":"diagnostic"}', 'native tool repair coordinator passes raw json to proposal parser');
  assertEqual(coordinator.parseSideEffectRepair({ raw: '{}', runId, sessionId, acceptedExecution: true }).kind, 'actionBundle', 'native tool repair coordinator parses side-effect repair with accepted execution kinds');
  assertEqual(repairedAllowedKinds[0], 'actionBundle', 'native tool repair coordinator forwards side-effect allowed kinds');
  assertEqual(coordinator.parseDuplicateRepair({ raw: '{}', runId, sessionId }).kind, 'resourceRequest', 'native tool repair coordinator parses duplicate repair with focused kinds');
  assertEqual(coordinator.parseProposalOnlyRepair({ raw: '{}', runId, sessionId }).kind, 'actionBundle', 'native tool repair coordinator parses proposal-only repair with executable kinds');
}

export function assertNativeToolProjectionBuilderBuildsDeltas(): void {
  const token = randomSmokeToken('native-projection');
  const runId = `run-${token}`;
  const sessionId = `session-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('target')}.txt`;
  const toolName = `read_${randomSmokeToken('tool')}`;
  const packet: ResourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    workspaceScopeKey: `scope-${token}`,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: `manifest-${token}`,
      readPolicy: 'autoRead',
      status: 'provided',
      path: targetPath,
      contentKind: 'fileText',
      promptContent: `payload-${randomSmokeToken('payload')}`,
    }],
  };
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: toolName,
    arguments: { path: targetPath, marker: token },
  };
  const builder = new NativeToolProjectionBuilder({
    conversationActivity: (input) => ({
      ...input,
      targets: input.targets ?? [],
    }),
    packetActivity: (_packet, activityId, activityRunId) => ({
      activityId,
      kind: 'resourceRead',
      status: 'completed',
      title: `packet-${token}`,
      summary: `packet-${token}`,
      source: 'kernel',
      runId: activityRunId,
      targets: [targetPath],
      itemCount: _packet.items.length,
    }),
    runningSummary: (name, language) => `running-${name}-${language}-${token}`,
    completedSummary: (name, language) => `completed-${name}-${language}-${token}`,
  });

  const checkpoint = builder.checkpointDelta({
    sessionId,
    runId,
    nativeToolRound: 3,
    toolCallCount: 2,
    resourcePacketCount: 5,
  });
  assertEqual(checkpoint.stage, 'native_tool_round_4', 'native tool projection builder creates checkpoint stage');
  assertEqual((checkpoint.payload as any).toolCallCount, 2, 'native tool projection builder carries checkpoint tool count');

  const duplicate = builder.duplicateReadDelta({
    sessionId,
    runId,
    toolCall,
    existing: {
      signature: { key: `sig-${token}`, toolName, path: targetPath },
      packet,
      contentHash: `hash-${token}`,
      repeatCount: 4,
    },
  });
  assertEqual(duplicate.stage, 'native_tool_duplicate_read', 'native tool projection builder creates duplicate read stage');
  assertEqual((duplicate.payload as any).duplicateOfPacketId, packet.id, 'native tool projection builder carries duplicate packet id');
  assertEqual((duplicate.activity as any).targets[0], targetPath, 'native tool projection builder carries duplicate target');

  const running = builder.toolCallRunningDelta({
    sessionId,
    runId,
    language: 'en-US',
    toolCall,
    nativeToolRound: 1,
  });
  assertEqual(running.type, 'tool_call_delta', 'native tool projection builder creates tool call delta');
  assertEqual(running.summary, `running-${toolName}-en-US-${token}`, 'native tool projection builder uses running summary port');
  assertEqual((running.payload as any).arguments.marker, token, 'native tool projection builder carries tool arguments');

  const resolved = builder.resourceResolvedDelta({
    sessionId,
    runId,
    language: 'zh-CN',
    toolCall,
    packet,
    nativeToolRound: 2,
    resourcePacketCount: 6,
  });
  assertEqual(resolved.type, 'resource_delta', 'native tool projection builder creates resource delta');
  assertEqual(resolved.summary, `completed-${toolName}-zh-CN-${token}`, 'native tool projection builder uses completed summary port');
  assertEqual((resolved.payload as any).packetId, packet.id, 'native tool projection builder carries packet id');
  assertEqual((resolved.activity as any).itemCount, 1, 'native tool projection builder uses packet activity port');
}

export function assertNativeToolProgressEventBuilderBuildsAssistantProgress(): void {
  const token = randomSmokeToken('native-progress');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const content = `progress-${randomSmokeToken('content')}`;
  const builder = new NativeToolProgressEventBuilder();
  const payload = builder.assistantProgressPayload({ runId, content });
  const event: AgentEvent = {
    id: `event-${token}`,
    sessionId,
    ts: `ts-${token}`,
    kind: 'assistant_msg',
    payload,
  };
  assertEqual(event.sessionId, sessionId, 'native tool progress event builder preserves session id');
  assertEqual(event.kind, 'assistant_msg', 'native tool progress event builder creates assistant message events');
  assertEqual(payload.content, content, 'native tool progress event builder carries visible content');
  assertEqual(payload.channel, 'progress', 'native tool progress event builder preserves progress channel');
  assertEqual(payload.source, 'llm', 'native tool progress event builder preserves llm source');
  assertEqual(payload.visibility, 'conversation', 'native tool progress event builder keeps conversation visibility');
  assertEqual(payload.presentation, 'body', 'native tool progress event builder keeps body presentation');
  assertEqual(payload.runId, runId, 'native tool progress event builder carries run id');
}

export function assertNativeToolResultMessageBuilderBuildsToolMessages(): void {
  const token = randomSmokeToken('native-result');
  const targetPath = `scope-${token}/target-${randomSmokeToken('target')}.txt`;
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: targetPath },
  };
  const packet: ResourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    workspaceScopeKey: `scope-${token}`,
    items: [],
  };
  const existing = {
    signature: { key: `sig-${token}`, toolName: toolCall.name, path: targetPath },
    packet,
    contentHash: `hash-${token}`,
    repeatCount: 1,
  };
  const builder = new NativeToolResultMessageBuilder({
    duplicateResult: (call, entry) => ({
      kind: `duplicate-${token}`,
      callId: call.callId,
      packetId: entry.packet.id,
    }),
    resultFromPacket: (call, resolvedPacket) => ({
      kind: `packet-${token}`,
      callId: call.callId,
      packetId: resolvedPacket.id,
      content: 'x'.repeat(128),
    }),
  }, 64);

  const duplicateMessage = builder.duplicateToolMessage(toolCall, existing);
  assertEqual(duplicateMessage.role, 'tool', 'native tool result message builder creates tool role for duplicate');
  assertEqual((duplicateMessage as any).toolCallId, toolCall.callId, 'native tool result message builder carries duplicate call id');
  assert((duplicateMessage as any).content.includes(`duplicate-${token}`), 'native tool result message builder serializes duplicate result');

  const packetMessage = builder.packetToolMessage(toolCall, packet);
  assertEqual(packetMessage.role, 'tool', 'native tool result message builder creates tool role for packet');
  assertEqual((packetMessage as any).toolCallId, toolCall.callId, 'native tool result message builder carries packet call id');
  assertEqual((packetMessage as any).content.endsWith('...'), true, 'native tool result message builder clips long packet result');
}

export function assertNativeToolResourceRecorderRecordsPackets(): void {
  const token = randomSmokeToken('native-recorder');
  const sessionId = `session-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('target')}.txt`;
  const packet: ResourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    workspaceScopeKey: `scope-${token}`,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: `manifest-${token}`,
      readPolicy: 'autoRead',
      status: 'provided',
      path: targetPath,
      contentKind: 'fileText',
      promptContent: `payload-${randomSmokeToken('payload')}`,
    }],
  };
  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `scope-${token}`,
    entries: [],
    budget: { maxEntries: 8, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  let discoveredPacketId = '';
  const recorder = new NativeToolResourceRecorder({
    packetContentHash: (value) => `hash-${value.id}`,
    addDiscoveredManifestEntries: (targetManifest, value) => {
      discoveredPacketId = value.id;
      targetManifest.entries.push({
        id: `entry-${token}`,
        kind: 'file',
        label: targetPath,
        resourceRef: targetPath,
        readPolicy: 'autoRead',
        reason: `reason-${token}`,
      });
    },
    packetEvent: (eventSessionId, value, ts, id) => ({
      id,
      sessionId: eventSessionId,
      ts,
      kind: 'tool_result',
      payload: {
        output: value,
      },
    }),
  });
  const state = {
    sessionId,
    manifest,
    resourcePackets: [] as ResourcePacket[],
    nativeToolReadLedger: new Map(),
  };
  const signature = {
    key: `sig-${token}`,
    toolName: `read_${randomSmokeToken('tool')}`,
    path: targetPath,
  };
  const event = recorder.recordResolvedPacket(state, signature, packet, {
    ts: `ts-${token}`,
    id: `event-${token}`,
  });

  assertEqual(state.resourcePackets[0]?.id, packet.id, 'native tool resource recorder appends packet to run state');
  assertEqual(state.nativeToolReadLedger.get(signature.key)?.contentHash, `hash-${packet.id}`, 'native tool resource recorder stores packet content hash');
  assertEqual(discoveredPacketId, packet.id, 'native tool resource recorder updates manifest entries through port');
  assertEqual(state.manifest.entries.length, 1, 'native tool resource recorder keeps discovered manifest mutation');
  assertEqual(event.id, `event-${token}`, 'native tool resource recorder returns packet event');
  assertEqual(event.sessionId, sessionId, 'native tool resource recorder keeps session id on packet event');
}

export function assertNativeToolResumeMessageBuilderAppendsToolMessages(): void {
  const token = randomSmokeToken('native-resume');
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: `scope-${token}/target-${randomSmokeToken('target')}.txt` },
  };
  const builder = new NativeToolResumeMessageBuilder({
    callToProtocol: (call) => ({
      id: call.callId,
      name: call.name,
      arguments: call.arguments,
    }),
  });
  const currentMessages: LlmChatRequest['messages'] = [
    { role: 'system', content: `system-${token}` },
    { role: 'user', content: `user-${token}` },
  ];
  const toolMessages: LlmChatRequest['messages'] = [{
    role: 'tool',
    toolCallId: toolCall.callId,
    content: `tool-result-${token}`,
  }];
  const messages = builder.nextMessages(
    currentMessages,
    {
      content: `assistant-${token}`,
      reasoning: `reasoning-${token}`,
      toolCalls: [toolCall],
    },
    toolMessages
  );

  assertEqual(messages.length, 4, 'native tool resume message builder appends assistant and tool messages');
  assertEqual(messages[2]?.role, 'assistant', 'native tool resume message builder places assistant resume before tool result');
  assertEqual((messages[2] as any).reasoningContent, undefined, 'native tool resume message builder does not replay private reasoning');
  assertEqual((messages[2] as any).toolCalls[0].id, toolCall.callId, 'native tool resume message builder converts native tool call to protocol call');
  assertEqual(messages[3]?.role, 'tool', 'native tool resume message builder appends tool message after assistant');
}

export function assertNativeToolExposurePolicySuppressesPlanningReadToolsAfterEvidence(): void {
  const token = randomSmokeToken('native-tool-policy');
  const policy = new NativeToolExposurePolicy();
  const tools = [{ name: `fs-read-${token}` } as any, { name: `fs-list-${token}` } as any];
  const planningFrame = {
    turnMode: 'planning',
    allowedKinds: ['answer', 'resourceRequest', 'taskPlan'],
  } as any;

  assertEqual(
    policy.providerTools({
      providerTurnFrame: planningFrame,
      resourcePackets: [{ id: `packet-${token}` } as ResourcePacket],
    }, tools).length,
    0,
    'planning native read tools are hidden when current ResourceEvidence is already available'
  );
  assertEqual(
    policy.providerTools({
      providerTurnFrame: planningFrame,
      resourcePackets: [],
    }, tools).length,
    tools.length,
    'planning native read tools remain available before any ResourceEvidence exists'
  );
  assertEqual(
    policy.providerTools({
      acceptedImplementationPlan: { id: `plan-${token}` },
      providerTurnFrame: { ...planningFrame, turnMode: 'acceptedTaskExecution' },
      resourcePackets: [{ id: `packet-${token}` } as ResourcePacket],
    }, tools).length,
    tools.length,
    'accepted execution does not inherit the planning native read tool suppression'
  );
}

export async function assertNativeToolProviderLoopResumesAfterToolMessages(): Promise<void> {
  const token = randomSmokeToken('native-loop');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: `scope-${token}/target-${randomSmokeToken('target')}.txt` },
  };
  const turns = [
    { content: `assistant-${token}`, reasoning: '', toolCalls: [toolCall] },
    { content: `final-${token}`, reasoning: '', toolCalls: [] },
  ];
  const stages: string[] = [];
  const messageCounts: number[] = [];
  const guidanceStages: string[] = [];
  const handlerPorts = { marker: token } as any;
  const loop = new NativeToolProviderLoop<any, string, any>({
    providerPipeline: {
      messages: () => [{ role: 'system', content: `system-${token}` }],
      runWithNativeTools: async (request: any) => {
        stages.push(request.stage);
        messageCounts.push(request.messages.length);
        assertEqual(request.options.tools[0].name, `tool-${token}`, 'native tool provider loop forwards provider tools');
        return turns.shift();
      },
    },
    turnHandler: {
      handle: async (request: any) => {
        assertEqual(request.round, 0, 'native tool provider loop starts handler at round zero');
        assertEqual(request.ports, handlerPorts, 'native tool provider loop forwards handler ports');
        return {
          kind: 'resume',
          toolMessages: [{ role: 'tool', toolCallId: toolCall.callId, content: `tool-result-${token}` }],
        };
      },
    },
    resumeMessageBuilder: {
      nextMessages: (currentMessages: LlmChatRequest['messages'], turn: any, toolMessages: LlmChatRequest['messages']) => [
        ...currentMessages,
        { role: 'assistant', content: turn.content },
        ...toolMessages,
      ],
    },
  });

  const state = {
    sessionId,
    runId,
    userRequest: `request-${token}`,
    manifest: {
      id: `manifest-${token}`,
      workspaceScopeKey: `scope-${token}`,
      entries: [],
      budget: { maxEntries: 8, maxBytes: 4096 },
      defaultDenyPatterns: [],
    },
    resourcePackets: [],
    nativeToolReadLedger: new Map(),
    nativeToolDuplicateRepairAttempted: false,
  };
  const loopInput = {
    profileId: `profile-${token}`,
    state,
    prompt: `prompt-${token}`,
    contract: {} as any,
    providerTools: [{ name: `tool-${token}` } as any],
    handlerPorts,
    runTurn: async () => {
      throw new Error('native tool provider loop test uses fake provider pipeline');
    },
    isEmptyResponseError: () => false,
    consumeGuidanceMessages: async (_state: any, stage: string): Promise<LlmChatRequest['messages']> => {
      guidanceStages.push(stage);
      return [{ role: 'user', content: `guidance-${token}` }];
    },
  };
  const first = await loop.run(loopInput);
  assertEqual((first as { kind?: string }).kind, 'providerResume', 'native tool provider step yields control after tool handling');
  const result = await loop.run(loopInput);

  assertEqual(result, `final-${token}`, 'native tool provider step returns final content after RunEngine resumes it');
  assertEqual(stages.join(','), 'provider_call,provider_tool_resume_1', 'native tool provider steps preserve resume stage names');
  assertEqual(guidanceStages[0], 'provider_call', 'native tool provider loop consumes guidance after tool handling');
  assertEqual(messageCounts[0], 1, 'native tool provider loop starts from provider messages');
  assertEqual(messageCounts[1], 4, 'native tool provider loop resumes with assistant, tool, and guidance messages');
}

export async function assertNativeToolHandlerPortsFactoryBuildsPorts(): Promise<void> {
  const token = randomSmokeToken('native-ports');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('target')}.txt`;
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: targetPath },
  };
  const packet: ResourcePacket = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    workspaceScopeKey: `scope-${token}`,
    items: [],
  };
  const state = {
    sessionId,
    runId,
    userRequest: `request-${token}`,
    manifest: {
      id: `manifest-${token}`,
      workspaceScopeKey: `scope-${token}`,
      entries: [],
      budget: { maxEntries: 8, maxBytes: 4096 },
      defaultDenyPatterns: [],
    },
    resourcePackets: [] as ResourcePacket[],
    nativeToolReadLedger: new Map(),
    nativeToolDuplicateRepairAttempted: false,
  };
  const appended: AgentEvent[] = [];
  const deltas: ProjectionDelta[] = [];
  const factory = new NativeToolHandlerPortsFactory<any, string, any>({
    progressEventBuilder: {
      assistantProgressPayload: (input) => ({
        kind: `progress-${token}`,
        runId: input.runId,
        content: input.content,
      }),
    },
    projectionBuilder: {
      checkpointDelta: (input) => ({ type: 'stage_delta', sessionId: input.sessionId, runId: input.runId, stage: `checkpoint-${token}`, status: 'running' }),
      duplicateReadDelta: (input) => ({ type: 'stage_delta', sessionId: input.sessionId, runId: input.runId, stage: `duplicate-${input.toolCall.callId}`, status: 'completed' }),
      toolCallRunningDelta: (input) => ({ type: 'tool_call_delta', sessionId: input.sessionId, runId: input.runId, stage: `running-${input.language}`, status: 'running' }),
      resourceResolvedDelta: (input) => ({ type: 'resource_delta', sessionId: input.sessionId, runId: input.runId, stage: `resolved-${input.packet.id}`, status: 'completed' }),
    },
    resultMessageBuilder: {
      duplicateToolMessage: () => ({ role: 'tool', toolCallId: toolCall.callId, content: `duplicate-${token}` }),
      packetToolMessage: () => ({ role: 'tool', toolCallId: toolCall.callId, content: `packet-${token}` }),
    },
    resourceRecorder: {
      recordResolvedPacket: (_state, _signature, resolvedPacket, identity) => ({
        id: identity.id,
        sessionId,
        ts: identity.ts,
        kind: 'tool_result',
        payload: { packetId: resolvedPacket.id },
      }),
    },
    visibleLanguage: () => 'en-US',
    event: (eventSessionId, kind, payload) => ({
      id: `event-${token}`,
      sessionId: eventSessionId,
      ts: `ts-${token}`,
      kind,
      payload,
    }),
    append: async (_sessionId, events) => {
      appended.push(...events);
    },
    emitProjectionDelta: async (_state, delta) => {
      deltas.push(delta);
    },
    now: () => `now-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
  });
  let repairPrompt = '';
  const ports = factory.create({
    prompt: `prompt-${token}`,
    repairSideEffect: async (_state, prompt) => {
      repairPrompt = prompt;
      return { kind: 'diagnostic', proposalId: `proposal-${token}`, runId, sessionId, source: 'llm', payload: {} } as ProposalEnvelope;
    },
    tryParseTurnProposal: () => null,
    repairDuplicate: async () => ({ kind: 'diagnostic', proposalId: `duplicate-${token}`, runId, sessionId, source: 'llm', payload: {} } as ProposalEnvelope),
    resolveReadToolCall: async () => packet,
  });

  await ports.appendAssistantProgress(state, `narration-${token}`);
  await ports.emitCheckpoint(state, 2, 3);
  await ports.emitToolCallRunning(state, toolCall, 4);
  await ports.recordResolvedPacket(state, { key: `sig-${token}`, toolName: toolCall.name, path: targetPath }, packet);
  await ports.emitResourceResolved(state, toolCall, packet, 5);
  const repaired = await ports.repairSideEffect(state, `ignored-${token}`, toolCall, { content: '', reasoning: '', toolCalls: [] });

  assertEqual((appended[0]?.payload as any).content, `narration-${token}`, 'native tool handler ports factory appends assistant progress content');
  assertEqual(deltas.map((delta) => delta.stage).join(','), `checkpoint-${token},running-en-US,resolved-${packet.id}`, 'native tool handler ports factory emits checkpoint/running/resolved deltas');
  assertEqual(appended[1]?.id, `native-resource-context-${token}`, 'native tool handler ports factory records resolved packet event');
  assertEqual((ports.duplicateToolMessage(toolCall, {
    signature: { key: `sig-${token}`, toolName: toolCall.name, path: targetPath },
    packet,
    contentHash: `hash-${token}`,
    repeatCount: 1,
  }) as any).content, `duplicate-${token}`, 'native tool handler ports factory delegates duplicate tool messages');
  assertEqual((ports.packetToolMessage(toolCall, packet) as any).content, `packet-${token}`, 'native tool handler ports factory delegates packet tool messages');
  assertEqual(repaired.kind, 'diagnostic', 'native tool handler ports factory delegates side-effect repair');
  assertEqual(repairPrompt, `prompt-${token}`, 'native tool handler ports factory uses bound prompt for repair callbacks');
}

export async function assertProposalOnlyProviderRunnerRepairsToolViolation(): Promise<void> {
  const token = randomSmokeToken('proposal-only');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const stage = `stage-${token}`;
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: `scope-${token}/target-${randomSmokeToken('target')}.txt` },
  };
  const repairedProposal = {
    kind: 'diagnostic',
    proposalId: `proposal-${token}`,
    runId,
    sessionId,
    source: 'llm',
    payload: { message: `diagnostic-${token}` },
  } as ProposalEnvelope;
  const emitted: ProjectionDelta[] = [];
  const repairStages: string[] = [];
  const repairMessages: LlmChatRequest['messages'][] = [];
  let providerStage = '';

  const runner = new ProposalOnlyProviderRunner<any, any>({
    providerPipeline: {
      runProposalOnly: async (request: any) => {
        providerStage = request.stage;
        return {
          content: `assistant-${token}`,
          reasoning: '',
          toolCalls: [toolCall],
        };
      },
    },
    repairCoordinator: {
      proposalOnlyToolViolationDelta: (input) => ({
        type: 'stage_delta',
        sessionId: input.sessionId,
        runId: input.runId,
        stage: `tool-violation-${input.toolCall.callId}`,
        status: 'running',
      }),
      parseProposalOnlyRepair: (input) => {
        assertEqual(input.raw, `repair-raw-${token}`, 'proposal-only runner forwards repair raw response');
        assertEqual(input.runId, runId, 'proposal-only runner forwards run id to repair parser');
        assertEqual(input.sessionId, sessionId, 'proposal-only runner forwards session id to repair parser');
        return repairedProposal;
      },
    },
  });

  const repaired = await runner.run({
    profileId: `profile-${token}`,
    state: { sessionId, runId },
    contract: {} as any,
    stage,
    acceptedPlanId: `plan-${token}`,
    runTurn: async () => {
      throw new Error('proposal-only runner smoke uses fake provider pipeline');
    },
    isEmptyResponseError: () => false,
    emitProjectionDelta: async (_state, delta) => {
      emitted.push(delta);
    },
    buildRepairMessages: (call, turn) => {
      assertEqual(call.callId, toolCall.callId, 'proposal-only runner builds repair messages with offending tool call');
      assertEqual(turn.content, `assistant-${token}`, 'proposal-only runner builds repair messages with original turn');
      return [{ role: 'user', content: `repair-request-${token}` }];
    },
    runRepair: async (repairStage, messages) => {
      repairStages.push(repairStage);
      repairMessages.push(messages);
      return `repair-raw-${token}`;
    },
    repairErrorMessage: (error) => String(error),
  });

  assertEqual(providerStage, stage, 'proposal-only runner delegates provider stage');
  assertEqual(emitted[0]?.stage, `tool-violation-${toolCall.callId}`, 'proposal-only runner emits tool violation delta');
  assertEqual(repairStages[0], `${stage}_tool_violation_repair`, 'proposal-only runner uses repair stage suffix');
  assertEqual((repairMessages[0]?.[0] as any)?.content, `repair-request-${token}`, 'proposal-only runner uses repair messages');
  assertEqual(repaired.kind, 'proposal', 'proposal-only runner returns parsed repair proposal');
  assertEqual(repaired.kind === 'proposal' ? repaired.proposal.proposalId : '', repairedProposal.proposalId, 'proposal-only runner preserves repaired proposal');

  const contentRunner = new ProposalOnlyProviderRunner<any, any>({
    providerPipeline: {
      runProposalOnly: async () => ({
        content: `content-${token}`,
        reasoning: '',
        toolCalls: [],
      }),
    },
    repairCoordinator: {
      proposalOnlyToolViolationDelta: () => {
        throw new Error('proposal-only runner must not emit repair delta without tool calls');
      },
      parseProposalOnlyRepair: () => {
        throw new Error('proposal-only runner must not parse repair without tool calls');
      },
    },
  });
  const content = await contentRunner.run({
    state: { sessionId, runId },
    contract: {} as any,
    stage: `${stage}-content`,
    runTurn: async () => {
      throw new Error('proposal-only runner content smoke uses fake provider pipeline');
    },
    isEmptyResponseError: () => false,
    emitProjectionDelta: async () => {
      throw new Error('proposal-only runner must not emit content-only delta');
    },
    buildRepairMessages: () => [],
    runRepair: async () => '',
    repairErrorMessage: (error) => String(error),
  });
  assertEqual(content.kind, 'content', 'proposal-only runner returns content when no tool call is present');
  assertEqual(content.kind === 'content' ? content.content : '', `content-${token}`, 'proposal-only runner preserves content response');
}

export async function assertNativeToolRepairRunnerHandlesRepairs(): Promise<void> {
  const token = randomSmokeToken('native-repair-runner');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const targetPath = `scope-${token}/target-${randomSmokeToken('target')}.txt`;
  const toolCall = {
    callId: `call-${token}`,
    index: 0,
    name: `read_${randomSmokeToken('tool')}`,
    arguments: { path: targetPath },
  };
  const duplicate = {
    toolCall,
    signature: { key: `sig-${token}`, toolName: toolCall.name, path: targetPath, kind: 'file' as const },
    entry: {
      signature: { key: `sig-${token}`, toolName: toolCall.name, path: targetPath, kind: 'file' as const },
      packet: {
        id: `packet-${token}`,
        requestId: `request-${token}`,
        workspaceScopeKey: `scope-${token}`,
        items: [],
      },
      contentHash: `hash-${token}`,
      repeatCount: 2,
    },
  };
  const sideEffectProposal = {
    kind: 'diagnostic',
    proposalId: `side-${token}`,
    runId,
    sessionId,
    source: 'llm',
    payload: {},
  } as ProposalEnvelope;
  const duplicateProposal = {
    kind: 'resourceRequest',
    proposalId: `duplicate-${token}`,
    runId,
    sessionId,
    source: 'llm',
    payload: {},
  } as ProposalEnvelope;
  const emitted: ProjectionDelta[] = [];
  const stages: string[] = [];
  let sideEffectAcceptedExecution = false;
  let duplicateAcceptedExecution = false;
  let duplicateMarked = false;
  const runner = new NativeToolRepairRunner({
    repairCoordinator: {
      sideEffectBlockedDelta: (input: any) => ({ type: 'stage_delta', sessionId: input.sessionId, runId: input.runId, stage: `side-${input.toolCall.callId}`, status: 'failed' }),
      duplicateRepairDelta: (input: any) => ({ type: 'stage_delta', sessionId: input.sessionId, runId: input.runId, stage: `duplicate-${input.duplicates[0]?.signature.path}`, status: 'running' }),
      parseSideEffectRepair: (input: any) => {
        assertEqual(input.raw, `side-raw-${token}`, 'native tool repair runner forwards side-effect raw');
        assertEqual(input.acceptedExecution, true, 'native tool repair runner forwards side-effect accepted execution flag');
        return sideEffectProposal;
      },
      parseTurnProposal: (input: any) => input.turn.content.includes(token) ? sideEffectProposal : null,
      parseDuplicateRepair: (input: any) => {
        assertEqual(input.raw, `duplicate-raw-${token}`, 'native tool repair runner forwards duplicate raw');
        return duplicateProposal;
      },
      duplicateLoopError: (duplicates: any[]) => ({ code: `duplicate-loop-${token}`, message: duplicates[0]?.signature.path ?? '' }),
    } as any,
  });

  const sideEffect = await runner.repairSideEffect({
    state: { sessionId, runId },
    toolCall,
    turn: { content: `turn-${token}` },
    acceptedExecution: true,
    emitProjectionDelta: async (_state, delta) => {
      emitted.push(delta);
    },
    buildRepairMessages: (_toolCall, _turn, acceptedExecution) => {
      sideEffectAcceptedExecution = acceptedExecution;
      return [{ role: 'user', content: `side-request-${token}` }];
    },
    runRepair: async (stage, messages) => {
      stages.push(stage);
      assertEqual((messages[0] as any).content, `side-request-${token}`, 'native tool repair runner uses side-effect repair messages');
      return `side-raw-${token}`;
    },
    repairErrorMessage: (error) => String(error),
  });

  assertEqual(sideEffect.kind, 'proposal', 'native tool repair runner returns side-effect proposal');
  assertEqual(sideEffect.kind === 'proposal' ? sideEffect.proposal.proposalId : '', sideEffectProposal.proposalId, 'native tool repair runner preserves side-effect proposal');
  assertEqual(emitted[0]?.stage, `side-${toolCall.callId}`, 'native tool repair runner emits side-effect delta');
  assertEqual(stages[0], 'native_tool_side_effect_repair', 'native tool repair runner uses side-effect repair stage');
  assertEqual(sideEffectAcceptedExecution, true, 'native tool repair runner passes side-effect accepted execution to message builder');
  assertEqual(runner.parseTurnProposal({ sessionId, runId }, { content: `content-${token}` })?.proposalId, sideEffectProposal.proposalId, 'native tool repair runner delegates turn proposal parsing');

  const duplicateResult = await runner.repairDuplicate({
    state: { sessionId, runId },
    turn: { content: `duplicate-turn-${token}` },
    duplicates: [duplicate],
    duplicateRepairAttempted: false,
    markDuplicateRepairAttempted: () => {
      duplicateMarked = true;
    },
    emitProjectionDelta: async (_state, delta) => {
      emitted.push(delta);
    },
    buildRepairMessages: (_turn, _duplicates, acceptedExecution) => {
      duplicateAcceptedExecution = acceptedExecution;
      return [{ role: 'user', content: `duplicate-request-${token}` }];
    },
    runRepair: async (stage, messages) => {
      stages.push(stage);
      assertEqual((messages[0] as any).content, `duplicate-request-${token}`, 'native tool repair runner uses duplicate repair messages');
      return `duplicate-raw-${token}`;
    },
    repairErrorMessage: (error) => String(error),
    acceptedExecution: false,
  });

  assertEqual(duplicateMarked, true, 'native tool repair runner marks duplicate repair attempt before provider repair');
  assertEqual(duplicateResult.kind, 'proposal', 'native tool repair runner returns duplicate repair proposal');
  assertEqual(duplicateResult.kind === 'proposal' ? duplicateResult.proposal.proposalId : '', duplicateProposal.proposalId, 'native tool repair runner preserves duplicate proposal');
  assertEqual(stages[1], 'native_tool_duplicate_repair', 'native tool repair runner uses duplicate repair stage');
  assertEqual(duplicateAcceptedExecution, false, 'native tool repair runner passes duplicate accepted execution to message builder');

  const duplicateLoop = await runner.repairDuplicate({
    state: { sessionId, runId },
    turn: { content: `loop-${token}` },
    duplicates: [duplicate],
    duplicateRepairAttempted: true,
    markDuplicateRepairAttempted: () => {
      throw new Error('native tool repair runner must not mark duplicate repair twice');
    },
    emitProjectionDelta: async () => {
      throw new Error('native tool repair runner must not emit duplicate loop delta');
    },
    buildRepairMessages: () => [],
    runRepair: async () => '',
    repairErrorMessage: (error) => String(error),
    acceptedExecution: true,
  });
  assertEqual(duplicateLoop.kind, 'failed', 'native tool repair runner fails fast after duplicate repair loop');
  assertEqual(duplicateLoop.kind === 'failed' ? duplicateLoop.code : '', `duplicate-loop-${token}`, 'native tool repair runner preserves duplicate loop failure code');
}
