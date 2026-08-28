import type {
  AssistantDraftProjection,
  ContextCompositionMessage,
  ContextCompositionReceipt,
  LocalAgentError,
  ModelInteractionRequest,
  ModelMessage,
  NewSessionEvent,
  PlanAuthority,
  PlanIntent,
  ProviderTokenUsage,
  ProviderEvent,
  ProviderRequest,
  ProviderToolDefinition,
  SessionEvent,
  TodoItem,
  ToolDescriptor,
  ToolExecutionRecord,
  ToolExecutionRequest,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  KERNEL_REQUEST_VERSION,
  LOCAL_AGENT_PROTOCOL_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_INTENT,
  SESSION_CONTROL_TODO_UPDATE,
} from '@deepcode/protocol';
import type { AgentComposition, ContextMessageContribution } from './plugins.js';
import { recoverSession, type SessionState } from './reducer.js';
import {
  decodeSessionControlCall,
  SESSION_CONTROL_INSTRUCTIONS,
  SessionControlError,
  sessionControlToolDefinitions,
  type SessionControlCall,
} from './sessionControls.js';

export interface LoopSnapshot {
  events: readonly SessionEvent[];
  state: SessionState;
}

export type LoopCommand =
  | { type: 'start'; runId: string }
  | { type: 'resume'; runId: string; answerOnly?: boolean }
  | { type: 'cancel'; runId: string };

export type LoopResult =
  | {
      status: 'waiting';
      runId: string;
      reason: 'approval' | 'userInput' | 'plan';
      callId?: string;
      interactionId?: string;
      planId?: string;
    }
  | {
      status: 'settled';
      runId: string;
      outcome: 'completed' | 'failed' | 'cancelled' | 'indeterminate';
    };

export interface AgentLoopDeps {
  composition: AgentComposition;
  defaultProfileId?: string;
  providerRunState: ProviderRunTransientState;
  commit(event: NewSessionEvent | readonly NewSessionEvent[]): Promise<LoopSnapshot>;
  updateAssistantDraft(draft: AssistantDraftProjection | null): void;
  nextId(kind: string): string;
}

export interface ProviderRunTransientState {
  runId: string;
  observedCallIds: Set<string>;
  reasoningByCallId: Map<string, string>;
}

type ProviderTurnCommon = {
  contextUsage?: ProviderTokenUsage & { providerRequestId: string };
  todo?: { callId: string; providerCallId: string; items: TodoItem[] };
};

interface PreparedProviderRequest {
  request: ProviderRequest;
  receipt: ContextCompositionReceipt;
}

type ProviderTurn =
  | ({ kind: 'answer'; content: string; messageId?: string } & ProviderTurnCommon)
  | {
      kind: 'interaction';
      interactionId: string;
      providerCallId: string;
      request: ModelInteractionRequest;
      narrative?: string;
    } & ProviderTurnCommon
  | ({
      kind: 'plan';
      intent: PlanIntent;
      providerCallId: string;
      narrative?: string;
    } & ProviderTurnCommon)
  | ({
      kind: 'tools';
      calls: Array<{
        callId: string;
        providerCallId: string;
        name: string;
        input: Record<string, unknown>;
      }>;
      narrative?: string;
    } & ProviderTurnCommon)
  | ({
      kind: 'controlRejected';
      rejection: {
        callId: string;
        providerCallId: string;
        toolName: string;
        input: Record<string, unknown>;
        error: LocalAgentError;
      };
      narrative?: string;
    } & ProviderTurnCommon)
  | ({ kind: 'continue'; narrative?: string } & ProviderTurnCommon);

export async function runAgentLoop(
  initial: LoopSnapshot,
  command: LoopCommand,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<LoopResult> {
  let snapshot = initial;
  const runId = command.runId;
  const commit = async (
    event: NewSessionEvent | readonly NewSessionEvent[],
  ): Promise<void> => {
    snapshot = await deps.commit(event);
  };

  for (const requestEvent of pendingToolRequests(snapshot.events, runId)) {
    const existing = await deps.composition.kernel.readRecord(requestEvent.callId);
    if (existing) await commitToolRecord(existing, runId, requestEvent.callId, commit);
  }
  if (hasSettlement(snapshot.events, runId)) return settlementResult(snapshot.events, runId);

  try {
    if (command.type === 'cancel') return await cancelRun(snapshot, command, deps, commit);

    const recoveredFinalMessageId = latestAssistantMessageId(snapshot.events, runId);
    if (
      recoveredFinalMessageId
      && latestRunEventType(snapshot.events, runId) === 'message.committed'
    ) {
      await commit({
        type: 'run.settled',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: { outcome: 'completed', finalMessageId: recoveredFinalMessageId },
      });
      return { status: 'settled', runId, outcome: 'completed' };
    }

    const answerOnly = command.type === 'resume' && command.answerOnly === true
      || requiresAnswerOnly(snapshot.events, runId);
    while (true) {
      throwIfAborted(signal);
      const pending = pendingToolRequests(snapshot.events, runId);
      for (const requestEvent of pending) {
        const approval = latestApproval(snapshot.events, runId, requestEvent.callId);
        if (approval.requested && !approval.resolved) {
          return { status: 'waiting', runId, reason: 'approval', callId: requestEvent.callId };
        }
        const existing = await deps.composition.kernel.readRecord(requestEvent.callId);
        if (existing) {
          await commitToolRecord(existing, runId, requestEvent.callId, commit);
          continue;
        }
        throwIfAborted(signal);
        const request: ToolExecutionRequest = {
          schemaVersion: KERNEL_REQUEST_VERSION,
          type: 'tool.execute',
          requestId: deps.nextId('kernel-request'),
          sessionId: snapshot.state.sessionId,
          runId,
          callId: requestEvent.callId,
          attemptId: requestEvent.payload.attemptId,
          toolName: requestEvent.payload.toolName,
          input: requestEvent.payload.input,
          workspaceBindings: runWorkspaceBindings(snapshot, runId).map((binding) => binding.workspaceId),
          ...(selectedPlanAuthorities(snapshot.events, runId).length
            ? { planAuthorities: selectedPlanAuthorities(snapshot.events, runId) }
            : {}),
          ...(approval.resolved
            ? {
                nonWorkspaceAuthority: {
                  authorityId: approval.resolved.payload.authorityId,
                  decision: approval.resolved.payload.decision,
                },
              }
            : {}),
        };
        const reply = await executeUntilAbort(deps, request, signal);
        if (reply.callId !== requestEvent.callId) {
          throw new LoopFailure('kernel_call_identity_mismatch', 'Kernel 返回了其他工具调用的结果。');
        }
        if (reply.status === 'approvalRequired') {
          if (approval.resolved) {
            throw new LoopFailure('kernel_approval_not_honored', 'Kernel 未接受已持久化的用户决策。');
          }
          const approvalId = reply.approvalId || deps.nextId('approval');
          await commit([
            {
              type: 'approval.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              callId: requestEvent.callId,
              payload: { approvalId, preview: reply.preview },
            },
            {
              type: 'run.waiting',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { reason: 'approval', detail: reply.preview.summary },
            },
          ]);
          return { status: 'waiting', runId, reason: 'approval', callId: requestEvent.callId };
        }
        await commitToolRecord(reply.record, runId, requestEvent.callId, commit);
      }

      throwIfAborted(signal);
      const preparedProviderRequest = await buildProviderRequest(snapshot, runId, deps, answerOnly);
      await commit({
        type: 'context.composed',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: preparedProviderRequest.receipt,
      });
      const turn = await consumeProvider(preparedProviderRequest.request, runId, deps, signal);
      const turnFacts: NewSessionEvent[] = [];
      if ('narrative' in turn && turn.narrative) {
        turnFacts.push({
          type: 'narrative.committed',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: { narrativeId: deps.nextId('narrative'), content: turn.narrative },
        });
      }
      if (turn.contextUsage) {
        turnFacts.push({
          type: 'context.updated',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: turn.contextUsage,
        });
      }
      if (turn.todo) {
        turnFacts.push({
          type: 'todo.updated',
          sessionId: snapshot.state.sessionId,
          runId,
          callId: turn.todo.callId,
          payload: {
            providerCallId: turn.todo.providerCallId,
            items: turn.todo.items.map((item) => ({ ...item })),
          },
        });
      }

      switch (turn.kind) {
        case 'interaction': {
          await commit([
            ...turnFacts,
            {
              type: 'interaction.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: {
                interactionId: turn.interactionId,
                providerCallId: turn.providerCallId,
                ...turn.request,
              },
            },
            {
              type: 'run.waiting',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { reason: 'userInput', detail: turn.request.prompt },
            },
          ]);
          return {
            status: 'waiting',
            runId,
            reason: 'userInput',
            interactionId: turn.interactionId,
          };
        }
        case 'plan':
          if (snapshot.events.some((event) => (
            event.type === 'plan.intent.requested'
            && event.runId === runId
            && event.payload.planId === turn.intent.planId
          ))) {
            throw new LoopFailure('plan_id_reused', '同一运行不能重复使用 planId。');
          }
          assertPlanWorkspaceBindings(
            turn.intent,
            runWorkspaceBindings(snapshot, runId).map((binding) => binding.workspaceId),
          );
          await commit([
            ...turnFacts,
            {
              type: 'plan.intent.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { ...clonePlan(turn.intent), providerCallId: turn.providerCallId },
            },
            {
              type: 'run.waiting',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { reason: 'plan', detail: turn.intent.prompt },
            },
          ]);
          return {
            status: 'waiting',
            runId,
            reason: 'plan',
            planId: turn.intent.planId,
          };
        case 'answer': {
          const messageId = turn.messageId ?? deps.nextId('message');
          await commit([
            {
              type: 'message.committed',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { messageId, role: 'assistant', content: turn.content },
            },
            ...turnFacts,
            {
              type: 'run.settled',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { outcome: 'completed', finalMessageId: messageId },
            },
          ]);
          return { status: 'settled', runId, outcome: 'completed' };
        }
        case 'tools': {
          const seenCalls = new Set<string>();
          const events: NewSessionEvent[] = [...turnFacts];
          for (const call of turn.calls) {
            if (seenCalls.has(call.callId)) {
              throw new LoopFailure('provider_tool_call_duplicate', 'Provider 重复了工具调用标识。');
            }
            seenCalls.add(call.callId);
            events.push({
              type: 'tool.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              callId: call.callId,
              payload: {
                providerCallId: call.providerCallId,
                attemptId: deps.nextId('attempt'),
                toolName: call.name,
                input: call.input,
              },
            });
          }
          await commit(events);
          break;
        }
        case 'controlRejected': {
          const rejectionEvent: NewSessionEvent = {
            type: 'session.control.rejected',
            sessionId: snapshot.state.sessionId,
            runId,
            callId: turn.rejection.callId,
            payload: {
              providerCallId: turn.rejection.providerCallId,
              toolName: turn.rejection.toolName,
              input: { ...turn.rejection.input },
              error: { ...turn.rejection.error },
            },
          };
          const priorRejections = snapshot.events.filter((event) => (
            event.type === 'session.control.rejected' && event.runId === runId
          )).length;
          if (priorRejections === 0) {
            await commit([...turnFacts, rejectionEvent]);
            break;
          }
          await commit([
            ...turnFacts,
            rejectionEvent,
            {
              type: 'run.settled',
              sessionId: snapshot.state.sessionId,
              runId,
              payload: { outcome: 'failed', error: { ...turn.rejection.error } },
            },
          ]);
          return { status: 'settled', runId, outcome: 'failed' };
        }
        case 'continue':
          await commit(turnFacts);
          break;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return await cancelRun(snapshot, { type: 'cancel', runId }, deps, commit);
    }
    const failure = localAgentError(error);
    if (!hasSettlement(snapshot.events, runId)) {
      await commit({
        type: 'run.settled',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: { outcome: 'failed', error: failure },
      });
    }
    return { status: 'settled', runId, outcome: 'failed' };
  }
}

async function buildProviderRequest(
  snapshot: LoopSnapshot,
  runId: string,
  deps: AgentLoopDeps,
  answerOnly: boolean,
): Promise<PreparedProviderRequest> {
  const profileId = snapshot.state.run?.profileId ?? deps.defaultProfileId;
  const kernelTools = await deps.composition.kernel.listTools();
  const composedTools = answerOnly
    ? []
    : bindCallableToolSnapshot(kernelTools, deps.composition.toolIds);
  const controlTools = answerOnly
    ? []
    : sessionControlToolDefinitions().map(freezeProviderToolDefinition);
  const providerTools = Object.freeze([
    ...controlTools,
    ...composedTools,
  ]);
  assertUniqueProviderTools(providerTools.map((tool) => tool.name));
  const journalMessages = messagesFromJournal(
    snapshot.events,
    runId,
    deps.providerRunState,
  );
  const contextMessages = (
    await Promise.all(deps.composition.contextProviders.map(async (provider) => (
      await provider.provide({ sessionId: snapshot.state.sessionId, events: snapshot.events })
    ).map<ContextMessageContribution>((message, index) => ({
      contributionId: `context-provider:${provider.id}:${index}`,
      contributionKind: 'contextProviders',
      label: provider.id,
      message: cloneModelMessage(message),
    }))))
  ).flat();
  const instructions = deps.composition.instructions.map<ContextMessageContribution>((instruction) => ({
    contributionId: `instruction:${instruction.id}`,
    contributionKind: 'instructions',
    label: instruction.id,
    message: { role: 'system', content: instruction.text },
  }));
  instructions.push({
    contributionId: 'session:controls',
    contributionKind: 'sessionControls',
    label: 'Session control contract',
    message: { role: 'system', content: SESSION_CONTROL_INSTRUCTIONS },
  });
  instructions.push({
    contributionId: 'session:workspace-bindings',
    contributionKind: 'workspaceBindings',
    label: '当前运行的目录索引',
    message: {
      role: 'system',
      content: `当前 Session workspace binding（仅逻辑身份，不含绝对路径）：${JSON.stringify(
        runWorkspaceBindings(snapshot, runId),
      )}`,
    },
  });
  if (answerOnly) {
    instructions.push({
      contributionId: 'session:answer-only',
      contributionKind: 'instructions',
      label: 'Answer-only continuation',
      message: {
        role: 'system',
        content: '当前是 Plan ignore 后的 answer-only continuation。直接输出最终 Markdown 答复；不要调用任何工具或 Session control。',
      },
    });
  }
  const selected = await deps.composition.memory.select({
    events: snapshot.events,
    messages: [...instructions, ...contextMessages, ...journalMessages],
  });
  assertContextContributions(selected);
  const requestId = deps.nextId('provider-request');
  const request: ProviderRequest = {
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    requestId,
    sessionId: snapshot.state.sessionId,
    runId,
    ...(profileId ? { profileId } : {}),
    responseConstraint: answerOnly ? 'answerOnly' : 'normal',
    workspaceBindings: runWorkspaceBindings(snapshot, runId),
    messages: selected.map((item) => cloneModelMessage(item.message)),
    tools: providerTools,
  };
  return {
    request,
    receipt: buildContextCompositionReceipt(
      requestId,
      answerOnly ? 'answerOnly' : 'normal',
      selected,
      composedTools,
      controlTools,
      runWorkspaceBindings(snapshot, runId),
      snapshot.events,
    ),
  };
}

function assertUniqueProviderTools(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name.includes('__')) {
      throw new LoopFailure(
        'provider_tool_name_invalid',
        `Provider 工具名称不在可逆编码域内：${name}`,
      );
    }
    if (seen.has(name)) {
      throw new LoopFailure('provider_tool_name_conflict', `Provider 工具名称冲突：${name}`);
    }
    seen.add(name);
  }
}

function bindCallableToolSnapshot(
  kernelTools: readonly ToolDescriptor[],
  contributedToolIds: readonly string[],
): readonly ProviderToolDefinition[] {
  const kernelByName = new Map(kernelTools.map((tool) => [tool.name, tool]));
  const snapshot: ProviderToolDefinition[] = [];
  for (const toolId of contributedToolIds) {
    const tool = kernelByName.get(toolId);
    if (!tool) {
      throw new LoopFailure(
        'plugin_tool_not_kernel_backed',
        `插件工具 ${toolId} 没有 Kernel 目录定义。`,
      );
    }
    if (tool.availability === 'blocked') continue;
    snapshot.push(freezeProviderToolDefinition(tool));
  }
  snapshot.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return Object.freeze(snapshot);
}

function freezeProviderToolDefinition(
  tool: Pick<ProviderToolDefinition, 'name' | 'description' | 'inputSchema'>,
): ProviderToolDefinition {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: canonicalJsonObject(tool.inputSchema),
  });
}

function canonicalJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return canonicalJsonValue(value) as Record<string, unknown>;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalJsonValue));
  if (!isRecord(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, canonicalJsonValue(value[key])]),
  ));
}

function assertPlanWorkspaceBindings(intent: PlanIntent, bindings: readonly string[]): void {
  const bound = new Set(bindings);
  for (const option of intent.options) {
    for (const operation of option.operations) {
      if (!bound.has(operation.workspaceId)) {
        throw new LoopFailure(
          'plan_workspace_not_bound',
          `Plan 引用了当前 Session creation snapshot 之外的 workspaceId：${operation.workspaceId}`,
        );
      }
    }
  }
}

async function consumeProvider(
  request: ProviderRequest,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<ProviderTurn> {
  let deltas = '';
  let completeMessage: {
    messageId: string;
    content: string;
    reasoningContent?: string;
  } | undefined;
  const providerCalls: Array<{
    providerCallId: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送事件。',
      );
    }
    switch (event.type) {
      case 'text.delta': {
        deltas += event.data.text;
        deps.updateAssistantDraft({
          runId,
          turnId: request.requestId,
          content: deltas,
        });
        break;
      }
      case 'assistant.message':
        if (completeMessage) {
          throw new LoopFailure(
            'provider_message_duplicate',
            'Provider 同一 turn 返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        break;
      case 'tool.call':
        providerCalls.push({
          providerCallId: event.data.callId,
          name: event.data.name,
          input: event.data.input,
        });
        break;
      case 'completed':
        contextUsage = decodeContextUsage(event.data);
        completed = true;
        break;
      case 'failed':
        throw new LoopFailure(event.data.code, event.data.message);
    }
  }
  if (!completed) throw new LoopFailure('provider_stream_incomplete', 'Provider 流未产生完成事件。');
  if (completeMessage) {
    if (
      completeMessage.reasoningContent !== undefined
      && !completeMessage.reasoningContent.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_content_invalid',
        'Provider 返回了空的 reasoningContent。',
      );
    }
    if (deltas && completeMessage.content !== deltas) {
      throw new LoopFailure('provider_message_mismatch', 'Provider 最终消息与流式文本不一致。');
    }
    if (!deltas) {
      deltas = completeMessage.content;
      if (deltas) {
        deps.updateAssistantDraft({
          runId,
          turnId: request.requestId,
          content: deltas,
        });
      }
    }
  }

  if (request.responseConstraint === 'answerOnly') {
    if (providerCalls.length !== 0) {
      throw new LoopFailure(
        'answer_only_contract_violated',
        'Plan 已忽略；answer-only continuation 不能调用工具或 Session control。',
      );
    }
  }

  const usage = contextUsage
    ? { contextUsage: { ...contextUsage, providerRequestId: request.requestId } }
    : {};
  const narrative = deltas.trim() ? deltas : undefined;
  const seenCalls = new Set<string>();
  const declaredTools = new Set(request.tools.map((tool) => tool.name));
  for (const call of providerCalls) {
    if (!call.providerCallId || seenCalls.has(call.providerCallId)) {
      throw new LoopFailure(
        'provider_tool_call_duplicate',
        'Provider 工具调用标识为空或重复。',
      );
    }
    seenCalls.add(call.providerCallId);
    if (request.responseConstraint !== 'answerOnly' && !declaredTools.has(call.name)) {
      throw new LoopFailure(
        'provider_tool_not_declared',
        `Provider 调用了当前 turn 未声明的工具：${call.name}`,
      );
    }
  }
  const logicalCallIds = new Set<string>();
  const calls = providerCalls.map((call) => {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure(
        'logical_call_identity_invalid',
        'Session 必须为每个 Provider call 生成非空、唯一且不复用原生值的 LogicalCallId。',
      );
    }
    logicalCallIds.add(callId);
    return {
      callId,
      providerCallId: call.providerCallId,
      name: call.name,
      input: call.input,
    };
  });
  recordProviderTurnState(
    deps.providerRunState,
    runId,
    calls.map((call) => call.callId),
    completeMessage?.reasoningContent,
  );

  const controlCalls: Array<SessionControlCall & { providerCallId: string }> = [];
  const kernelCalls: typeof calls = [];
  for (const call of calls) {
    try {
      const control = decodeSessionControlCall(call.callId, call.name, call.input);
      if (control) controlCalls.push({ ...control, providerCallId: call.providerCallId });
      else kernelCalls.push(call);
    } catch (error) {
      if (!(error instanceof SessionControlError)) throw error;
      return {
        kind: 'controlRejected',
        rejection: {
          callId: call.callId,
          providerCallId: call.providerCallId,
          toolName: call.name,
          input: { ...call.input },
          error: { code: error.code, message: error.message },
        },
        ...(narrative ? { narrative } : {}),
        ...usage,
      };
    }
  }
  const blockingControls = controlCalls.filter(
    (control) => control.kind === 'interaction' || control.kind === 'plan',
  );
  const todoControls = controlCalls.filter(
    (control): control is Extract<SessionControlCall, { kind: 'todo' }>
      & { providerCallId: string } => control.kind === 'todo',
  );
  if (
    blockingControls.length > 1
    || todoControls.length > 1
    || blockingControls.length > 0 && (todoControls.length > 0 || kernelCalls.length > 0)
  ) {
    throw new LoopFailure(
      'session_control_turn_conflict',
      'interaction.request 或 plan.intent 必须独占 Provider turn；todo.update 每个 turn 最多一次，且只能与 Kernel 工具并存。',
    );
  }

  const todo = todoControls[0]
    ? {
        todo: {
          callId: todoControls[0].callId,
          providerCallId: todoControls[0].providerCallId,
          items: todoControls[0].items,
        },
      }
    : {};
  const common = { ...usage, ...todo };
  const control = blockingControls[0];
  if (control?.kind === 'interaction') {
    return {
      kind: 'interaction',
      interactionId: control.interactionId,
      providerCallId: control.providerCallId,
      request: control.request,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (control?.kind === 'plan') {
    return {
      kind: 'plan',
      intent: control.intent,
      providerCallId: control.providerCallId,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (kernelCalls.length > 0) {
    return {
      kind: 'tools',
      calls: kernelCalls,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (todoControls.length > 0) {
    return {
      kind: 'continue',
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (!narrative) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider turn 正常结束，但没有产生最终答复文本。',
    );
  }
  return {
    kind: 'answer',
    content: narrative,
    ...(completeMessage ? { messageId: completeMessage.messageId } : {}),
    ...common,
  };
}

function messagesFromJournal(
  events: readonly SessionEvent[],
  runId: string,
  providerRunState: ProviderRunTransientState,
): ContextMessageContribution[] {
  const messages: ContextMessageContribution[] = [];
  for (const event of events) {
    if (event.type === 'message.committed') {
      messages.push({
        contributionId: `message:${event.payload.messageId}`,
        contributionKind: 'journalMessages',
        label: event.payload.role === 'user' ? '用户消息' : 'Assistant 消息',
        message: { role: event.payload.role, content: messageContentForModel(event.payload) },
      });
    } else if (event.type === 'narrative.committed') {
      messages.push({
        contributionId: `narrative:${event.payload.narrativeId}`,
        contributionKind: 'journalMessages',
        label: '运行叙述',
        message: { role: 'assistant', content: event.payload.content },
      });
    } else if (event.type === 'interaction.requested') {
      attachToolCall(messages, {
        callId: event.payload.interactionId,
        name: SESSION_CONTROL_INTERACTION_REQUEST,
        input: {
          kind: event.payload.kind,
          prompt: event.payload.prompt,
          options: event.payload.options,
          allowFreeform: event.payload.allowFreeform,
        },
      });
    } else if (event.type === 'interaction.resolved') {
      messages.push({
        contributionId: `interaction-result:${event.payload.interactionId}`,
        contributionKind: 'journalMessages',
        label: '用户交互答复',
        message: {
          role: 'tool',
          toolCallId: event.payload.interactionId,
          content: JSON.stringify({ response: event.payload.response }),
        },
      });
    } else if (event.type === 'plan.intent.requested') {
      attachToolCall(messages, {
        callId: event.payload.planId,
        name: SESSION_CONTROL_PLAN_INTENT,
        input: {
          prompt: event.payload.prompt,
          options: event.payload.options,
        },
      });
    } else if (event.type === 'plan.intent.resolved') {
      messages.push({
        contributionId: `plan-result:${event.payload.planId}`,
        contributionKind: 'journalMessages',
        label: '用户 Plan 答复',
        message: {
          role: 'tool',
          toolCallId: event.payload.planId,
          content: JSON.stringify({ response: event.payload.response }),
        },
      });
    } else if (event.type === 'todo.updated') {
      attachToolCall(messages, {
        callId: event.callId,
        name: SESSION_CONTROL_TODO_UPDATE,
        input: { items: event.payload.items },
      });
      messages.push({
        contributionId: `todo-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: 'Todo 更新结果',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          content: JSON.stringify({ accepted: true }),
        },
      });
    } else if (event.type === 'session.control.rejected') {
      attachToolCall(messages, {
        callId: event.callId,
        name: event.payload.toolName,
        input: event.payload.input,
      });
      messages.push({
        contributionId: `session-control-rejection:${event.callId}`,
        contributionKind: 'journalMessages',
        label: 'Session control 拒绝结果',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          content: JSON.stringify({ accepted: false, error: event.payload.error }),
        },
      });
    } else if (event.type === 'tool.requested') {
      attachToolCall(messages, {
        callId: event.callId,
        name: event.payload.toolName,
        input: event.payload.input,
      });
    } else if (event.type === 'tool.completed') {
      messages.push({
        contributionId: `tool-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: `${event.payload.record.preparedEffect.operation} 结果`,
        message: {
          role: 'tool',
          toolCallId: event.callId,
          content: JSON.stringify(toolResultForModel(event.payload.record)),
        },
      });
    }
  }
  applyProviderRunState(messages, currentRunCallIds(events, runId), providerRunState);
  return messages;
}

function recordProviderTurnState(
  state: ProviderRunTransientState,
  runId: string,
  callIds: readonly string[],
  reasoningContent?: string,
): void {
  if (state.runId !== runId) {
    throw new LoopFailure(
      'provider_transient_run_identity_mismatch',
      'Provider 瞬态 turn 状态不属于当前运行。',
    );
  }
  for (const callId of callIds) {
    state.observedCallIds.add(callId);
    if (reasoningContent !== undefined) state.reasoningByCallId.set(callId, reasoningContent);
  }
}

function applyProviderRunState(
  messages: ContextMessageContribution[],
  currentCallIds: ReadonlySet<string>,
  state: ProviderRunTransientState,
): void {
  for (const contribution of messages) {
    const message = contribution.message;
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const callIds = message.toolCalls
      .map((call) => call.callId)
      .filter((callId) => currentCallIds.has(callId));
    if (!callIds.length) continue;
    const missing = callIds.filter((callId) => !state.observedCallIds.has(callId));
    if (missing.length) {
      throw new LoopFailure(
        'provider_transient_turn_state_missing',
        '当前工具续轮所需的 Provider 瞬态 turn 状态已丢失，不能猜测或重新构造。',
      );
    }
    const reasoning = [...new Set(callIds.flatMap((callId) => {
      const value = state.reasoningByCallId.get(callId);
      return value === undefined ? [] : [value];
    }))];
    if (reasoning.length > 1) {
      throw new LoopFailure(
        'provider_transient_turn_state_conflict',
        '同一 assistant tool-call turn 关联了冲突的 Provider 瞬态状态。',
      );
    }
    if (reasoning[0] !== undefined) message.reasoningContent = reasoning[0];
  }
}

function currentRunCallIds(events: readonly SessionEvent[], runId: string): Set<string> {
  const callIds = new Set<string>();
  for (const event of events) {
    if (!('runId' in event) || event.runId !== runId) continue;
    if (event.type === 'interaction.requested') callIds.add(event.payload.interactionId);
    else if (event.type === 'plan.intent.requested') callIds.add(event.payload.planId);
    else if (
      event.type === 'todo.updated'
      || event.type === 'tool.requested'
      || event.type === 'session.control.rejected'
    ) {
      callIds.add(event.callId);
    }
  }
  return callIds;
}

function attachToolCall(
  messages: ContextMessageContribution[],
  call: NonNullable<ModelMessage['toolCalls']>[number],
): void {
  const last = messages.at(-1);
  if (
    last?.message.role === 'assistant'
    && !last.message.toolCalls?.some((candidate) => candidate.callId === call.callId)
  ) {
    last.message.toolCalls = [...(last.message.toolCalls ?? []), call];
    return;
  }
  messages.push({
    contributionId: `tool-call:${call.callId}`,
    contributionKind: 'journalMessages',
    label: call.name,
    message: { role: 'assistant', content: '', toolCalls: [call] },
  });
}

function buildContextCompositionReceipt(
  providerRequestId: string,
  responseConstraint: ContextCompositionReceipt['responseConstraint'],
  selected: readonly ContextMessageContribution[],
  kernelTools: readonly ProviderToolDefinition[],
  controlTools: readonly ProviderToolDefinition[],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  events: readonly SessionEvent[],
): ContextCompositionReceipt {
  const attachmentFactsByContributionId = new Map<string, Array<{
    attachmentId: string;
    name: string;
    mediaType: string;
    content: string;
  }>>();
  for (const event of events) {
    if (event.type !== 'message.committed') continue;
    const attachments = (event.payload.attachments ?? []).map((attachment) => ({ ...attachment }));
    if (attachments.length > 0) {
      attachmentFactsByContributionId.set(`message:${event.payload.messageId}`, attachments);
    }
  }
  const workspaceBindingItems = workspaceBindings.map((binding) => ({
    itemId: binding.workspaceId,
    label: binding.displayName,
  }));
  const toolItems = kernelTools.map((tool) => ({ itemId: tool.name, label: tool.name }));
  const messages = selected.map((item, messageIndex) => ({
    messageIndex,
    contributionId: item.contributionId,
    contributionKind: item.contributionKind,
    label: item.label,
    role: item.message.role,
    blocks: contextCompositionBlocks(item.message),
    attachments: (attachmentFactsByContributionId.get(item.contributionId) ?? []).map((attachment) => ({
      itemId: attachment.attachmentId,
      label: attachment.name,
    })),
  }));
  return {
    providerRequestId,
    responseConstraint,
    messages,
    workspaceBindings: workspaceBindingItems,
    tools: toolItems,
    partitions: buildContextCompositionPartitions(
      selected,
      kernelTools,
      controlTools,
      workspaceBindings,
      attachmentFactsByContributionId,
    ),
  };
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'messageAttachments',
] as const;

function buildContextCompositionPartitions(
  selected: readonly ContextMessageContribution[],
  kernelTools: readonly ProviderToolDefinition[],
  controlTools: readonly ProviderToolDefinition[],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  attachmentFactsByContributionId: ReadonlyMap<string, readonly unknown[]>,
): NonNullable<ContextCompositionReceipt['partitions']> {
  const metrics = new Map(CONTEXT_PARTITION_ORDER.map((kind) => [kind, {
    itemCount: 0,
    requestShapeUnits: 0,
  }]));
  const add = (
    kind: typeof CONTEXT_PARTITION_ORDER[number],
    itemCount: number,
    requestShapeUnits: number,
  ): void => {
    const metric = metrics.get(kind)!;
    metric.itemCount += itemCount;
    metric.requestShapeUnits += requestShapeUnits;
  };
  for (const contribution of selected) {
    const messageUnits = jsonShapeUnits(contribution.message);
    const attachments = attachmentFactsByContributionId.get(contribution.contributionId) ?? [];
    const attachmentUnits = Math.min(messageUnits, attachments.length
      ? jsonShapeUnits(attachments)
      : 0);
    if (attachments.length > 0) {
      add('messageAttachments', attachments.length, attachmentUnits);
    }
    if (contribution.contributionKind === 'workspaceBindings') {
      add('workspaceBindings', workspaceBindings.length, messageUnits - attachmentUnits);
    } else {
      add(contribution.contributionKind, 1, messageUnits - attachmentUnits);
    }
  }
  add('sessionControls', controlTools.length, sumShapeUnits(controlTools));
  add('tools', kernelTools.length, sumShapeUnits(kernelTools));
  return CONTEXT_PARTITION_ORDER.map((kind) => ({ kind, ...metrics.get(kind)! }));
}

function sumShapeUnits(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => total + jsonShapeUnits(value), 0);
}

function jsonShapeUnits(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded ? new TextEncoder().encode(encoded).byteLength : 0;
}

function contextCompositionBlocks(message: ModelMessage): ContextCompositionMessage['blocks'] {
  const blocks: ContextCompositionMessage['blocks'] = [];
  const append = (
    block:
      | { kind: 'text' | 'reasoning' }
      | { kind: 'toolCall'; callId: string; toolName: string }
      | { kind: 'toolResult'; resultForCallId: string },
  ): void => {
    blocks.push({
      ...block,
      blockIndex: blocks.length,
    } as ContextCompositionMessage['blocks'][number]);
  };
  if (message.role === 'tool' && message.toolCallId) {
    append({ kind: 'toolResult', resultForCallId: message.toolCallId });
    return blocks;
  }
  if (message.reasoningContent) append({ kind: 'reasoning' });
  if (message.content) append({ kind: 'text' });
  for (const call of message.toolCalls ?? []) {
    append({ kind: 'toolCall', callId: call.callId, toolName: call.name });
  }
  return blocks;
}

const CONTEXT_MESSAGE_KINDS: readonly ContextCompositionMessage['contributionKind'][] = [
  'instructions',
  'workspaceBindings',
  'sessionControls',
  'journalMessages',
  'contextProviders',
];

function assertContextContributions(
  contributions: readonly ContextMessageContribution[],
): void {
  const seen = new Set<string>();
  for (const contribution of contributions) {
    if (!contribution.contributionId || seen.has(contribution.contributionId)) {
      throw new LoopFailure(
        'context_contribution_identity_invalid',
        'Memory provider 返回了空或重复的上下文贡献标识。',
      );
    }
    if (!CONTEXT_MESSAGE_KINDS.includes(contribution.contributionKind)) {
      throw new LoopFailure(
        'context_contribution_kind_invalid',
        `Memory provider 返回了未知的上下文贡献类型：${contribution.contributionKind}`,
      );
    }
    if (!contribution.label || !contribution.message) {
      throw new LoopFailure(
        'context_contribution_shape_invalid',
        'Memory provider 返回的上下文贡献缺少标签或消息。',
      );
    }
    seen.add(contribution.contributionId);
  }
}

function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            input: { ...call.input },
          })),
        }
      : {}),
  };
}

function messageContentForModel(
  payload: Extract<SessionEvent, { type: 'message.committed' }>['payload'],
): string {
  if (!payload.attachments?.length) return payload.content;
  return `${payload.content}\n\n用户明确附加的文件（内容按 JSON 精确编码）：\n${JSON.stringify(
    payload.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mediaType: attachment.mediaType,
      content: attachment.content,
    })),
  )}`;
}

function toolResultForModel(record: ToolExecutionRecord): Record<string, unknown> {
  if (record.outcome === 'completed') return { outcome: record.outcome, output: record.output };
  if (record.outcome === 'failed' || record.outcome === 'indeterminate') {
    return { outcome: record.outcome, error: record.error };
  }
  return {
    outcome: record.outcome,
    ...('error' in record && record.error ? { error: record.error } : {}),
  };
}

function selectedPlanAuthorities(events: readonly SessionEvent[], runId: string): PlanAuthority[] {
  const lastIgnore = events.findLast(
    (event): event is Extract<SessionEvent, { type: 'plan.intent.resolved' }> => (
      event.type === 'plan.intent.resolved'
      && event.runId === runId
      && event.payload.response.kind === 'ignore'
    ),
  )?.sequence ?? 0;
  return events.flatMap((event) => (
    event.type === 'plan.intent.resolved'
    && event.runId === runId
    && event.sequence > lastIgnore
    && event.payload.response.kind === 'select'
      ? (event.payload.authorities ?? []).map(cloneAuthority)
      : []
  ));
}

function cloneAuthority(authority: PlanAuthority): PlanAuthority {
  return {
    ...authority,
    coveredOperations: authority.coveredOperations.map((operation) => ({ ...operation })),
  };
}

function requiresAnswerOnly(events: readonly SessionEvent[], runId: string): boolean {
  const lastResolution = events.findLast(
    (event): event is Extract<SessionEvent, { type: 'plan.intent.resolved' }> => (
      event.type === 'plan.intent.resolved' && event.runId === runId
    ),
  );
  return lastResolution?.payload.response.kind === 'ignore';
}

async function cancelRun(
  snapshot: LoopSnapshot,
  command: Extract<LoopCommand, { type: 'cancel' }>,
  deps: AgentLoopDeps,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<LoopResult> {
  if (hasSettlement(snapshot.events, command.runId)) {
    return settlementResult(snapshot.events, command.runId);
  }
  let indeterminate: LocalAgentError | undefined;
  const current = pendingToolRequests(snapshot.events, command.runId)[0];
  if (current) {
    const reply = await deps.composition.kernel.cancel(current.callId, current.payload.attemptId);
    if (reply.status !== 'notFound') {
      await commitToolRecord(reply.record, command.runId, current.callId, commit);
      if (reply.record.outcome === 'indeterminate') indeterminate = reply.record.error;
    } else if (!latestApproval(snapshot.events, command.runId, current.callId).requested) {
      indeterminate = {
        code: 'tool_effect_outcome_unknown',
        message: '取消时 Kernel 没有该调用的确定记录。',
      };
    }
  }
  if (indeterminate) {
    await commit({
      type: 'run.settled',
      sessionId: snapshot.state.sessionId,
      runId: command.runId,
      payload: { outcome: 'indeterminate', error: indeterminate },
    });
    return { status: 'settled', runId: command.runId, outcome: 'indeterminate' };
  }
  await commit({
    type: 'run.settled',
    sessionId: snapshot.state.sessionId,
    runId: command.runId,
    payload: { outcome: 'cancelled' },
  });
  return { status: 'settled', runId: command.runId, outcome: 'cancelled' };
}

async function executeUntilAbort(
  deps: AgentLoopDeps,
  request: ToolExecutionRequest,
  signal: AbortSignal,
) {
  const execution = deps.composition.kernel.execute(request);
  void execution.catch(() => undefined);
  if (signal.aborted) throw signal.reason ?? new Error('run_cancelled');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('run_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function commitToolRecord(
  record: ToolExecutionRecord,
  runId: string,
  callId: string,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<void> {
  if (record.runId !== runId || record.callId !== callId) {
    throw new LoopFailure('kernel_record_identity_mismatch', 'Kernel 记录不属于当前运行或调用。');
  }
  await commit({
    type: 'tool.completed',
    sessionId: record.sessionId,
    runId,
    callId,
    payload: { record },
  });
}

function pendingToolRequests(
  events: readonly SessionEvent[],
  runId: string,
): Array<Extract<SessionEvent, { type: 'tool.requested' }>> {
  const completed = new Set(events.flatMap((event) => (
    event.type === 'tool.completed' && event.runId === runId ? [event.callId] : []
  )));
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool.requested' }> => (
      event.type === 'tool.requested'
      && event.runId === runId
      && !completed.has(event.callId)
    ),
  );
}

function latestApproval(
  events: readonly SessionEvent[],
  runId: string,
  callId: string,
): {
  requested?: Extract<SessionEvent, { type: 'approval.requested' }>;
  resolved?: Extract<SessionEvent, { type: 'approval.resolved' }>;
} {
  const result: {
    requested?: Extract<SessionEvent, { type: 'approval.requested' }>;
    resolved?: Extract<SessionEvent, { type: 'approval.resolved' }>;
  } = {};
  for (const event of events) {
    if (event.type === 'approval.requested' && event.runId === runId && event.callId === callId) {
      result.requested = event;
    }
    if (event.type === 'approval.resolved' && event.runId === runId && event.callId === callId) {
      result.resolved = event;
    }
  }
  return result;
}

function decodeContextUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const value = data.usage;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的 usage 不是对象。');
  }
  const inputTokens = positiveOrZeroInteger(value.inputTokens);
  const outputTokens = positiveOrZeroInteger(value.outputTokens);
  const contextWindowTokens = positiveInteger(value.contextWindowTokens);
  const cacheReadPresent = Object.hasOwn(value, 'cacheReadInputTokens');
  const cacheMissPresent = Object.hasOwn(value, 'cacheMissInputTokens');
  const cacheReadInputTokens = !cacheReadPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheReadInputTokens);
  const cacheMissInputTokens = !cacheMissPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheMissInputTokens);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || contextWindowTokens === undefined
    || inputTokens + outputTokens > contextWindowTokens
    || cacheReadPresent !== cacheMissPresent
    || cacheReadPresent && (cacheReadInputTokens === undefined || cacheMissInputTokens === undefined)
    || cacheReadInputTokens !== undefined && cacheMissInputTokens !== undefined
      && cacheReadInputTokens + cacheMissInputTokens > inputTokens
  ) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的上下文计数无效。');
  }
  return {
    inputTokens,
    outputTokens,
    contextWindowTokens,
    ...(cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens, cacheMissInputTokens: cacheMissInputTokens! }),
  };
}

function assertProviderEvent(event: ProviderEvent, requestId: string): void {
  if (event.requestId !== requestId) {
    throw new LoopFailure('provider_request_identity_mismatch', 'Provider 事件属于其他请求。');
  }
}

function clonePlan(plan: PlanIntent): PlanIntent {
  return {
    planId: plan.planId,
    prompt: plan.prompt,
    options: plan.options.map((option) => ({
      ...option,
      operations: option.operations.map((operation) => ({ ...operation })),
    })),
  };
}

function hasSettlement(events: readonly SessionEvent[], runId: string): boolean {
  return events.some((event) => event.type === 'run.settled' && event.runId === runId);
}

function latestRunEventType(
  events: readonly SessionEvent[],
  runId: string,
): SessionEvent['type'] | undefined {
  return events.findLast((event) => 'runId' in event && event.runId === runId)?.type;
}

function latestAssistantMessageId(events: readonly SessionEvent[], runId: string): string | undefined {
  return events.findLast(
    (event): event is Extract<SessionEvent, { type: 'message.committed' }> => (
      event.type === 'message.committed'
      && event.runId === runId
      && event.payload.role === 'assistant'
    ),
  )?.payload.messageId;
}

function settlementResult(events: readonly SessionEvent[], runId: string): LoopResult {
  const event = events.findLast(
    (candidate): candidate is Extract<SessionEvent, { type: 'run.settled' }> => (
      candidate.type === 'run.settled' && candidate.runId === runId
    ),
  );
  if (!event) throw new Error('run_settlement_missing');
  return { status: 'settled', runId, outcome: event.payload.outcome };
}

export function loopSnapshot(sessionId: string, events: readonly SessionEvent[]): LoopSnapshot {
  return { events: [...events], state: recoverSession(sessionId, events) };
}

function runWorkspaceBindings(
  snapshot: LoopSnapshot,
  runId: string,
): WorkspaceBindingDisplay[] {
  const run = snapshot.state.run;
  if (!run || run.runId !== runId) {
    throw new LoopFailure('run_workspace_snapshot_missing', '当前 run 缺少冻结的目录索引快照。');
  }
  return run.workspaceBindings.map((binding) => ({ ...binding }));
}

function positiveOrZeroInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('run_cancelled');
}

function localAgentError(error: unknown): LocalAgentError {
  if (error instanceof LoopFailure) return { code: error.code, message: error.message };
  if (error instanceof SessionControlError) return { code: error.code, message: error.message };
  return {
    code: 'agent_loop_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class LoopFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LoopFailure';
  }
}
