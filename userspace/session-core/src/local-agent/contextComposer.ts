import type {
  ContextCompositionMessage,
  ContextCompositionReceipt,
  ContextCompositionTool,
  ModelMessage,
  ProviderRequest,
  ProviderToolDefinition,
  RunRuntimeSnapshot,
  SessionEvent,
  ToolExecutionRecord,
  TodoListProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  LOCAL_AGENT_PROTOCOL_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_PLAN_PROGRESS,
} from '@deepcode/protocol';
import { LoopFailure } from './loopFailure.js';
import type {
  ContextMessageContribution,
  ContextProvider,
  MemoryProvider,
} from './plugins.js';
import {
  canonicalJsonValue,
  createProviderToolCodec,
  encodeProviderMessage,
  providerMessageCodecsByCallId,
  providerWorkspaceBindings,
  providerWireName,
  type ProviderToolCodec,
} from './providerToolCodec.js';
import {
  confirmedPlanExecutionInstruction,
  sessionControlInstructions,
  sessionControlToolDefinitions,
} from './sessionControls.js';
import { renderActiveToolGuidance } from './toolPromptContributions.js';

export interface PreparedProviderRequest {
  request: ProviderRequest;
  receipt: ContextCompositionReceipt;
  toolCodec: ProviderToolCodec;
}

type ProviderTurnSettledEvent = Extract<SessionEvent, { type: 'provider.turn.settled' }>;
type CompletedProviderTurnEvent = ProviderTurnSettledEvent & {
  payload: Extract<ProviderTurnSettledEvent['payload'], { outcome: 'completed' }>;
};

export async function buildAgentProviderRequest(input: {
  sessionId: string;
  runId: string;
  runtime: RunRuntimeSnapshot;
  events: readonly SessionEvent[];
  responseConstraint: 'normal' | 'toolRequired';
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  contextProviders: readonly ContextProvider[];
  memory: MemoryProvider;
  providerRequestId: string;
}): Promise<PreparedProviderRequest> {
  const hasWorkspaceBindings = input.workspaceBindings.length > 0;
  const firstRun = input.events.find((event) => event.type === 'run.started');
  const prefixBindings = firstRun?.type === 'run.started' ? firstRun.payload.workspaceBindings : input.workspaceBindings;
  const controlNames = {
    interactionRequest: providerWireName(input.runtime, SESSION_CONTROL_INTERACTION_REQUEST),
    planPublish: providerWireName(input.runtime, SESSION_CONTROL_PLAN_PUBLISH),
    planProgress: providerWireName(input.runtime, SESSION_CONTROL_PLAN_PROGRESS),
  };
  const runtimeTools = hasWorkspaceBindings
    ? input.runtime.tools
    : input.runtime.tools.filter((tool) => !tool.possibleEffects.some((effect) => (
      effect === 'workspaceRead'
      || effect === 'workspaceMutation'
      || effect === 'process'
    )));
  const hostedTools: ProviderRequest['hostedTools'] = input.runtime.webSearch.owner === 'providerHosted'
    ? [{ type: 'webSearch', providerToolType: input.runtime.webSearch.providerToolType }]
    : [];
  const controlTools = hasWorkspaceBindings
    ? sessionControlToolDefinitions()
    : sessionControlToolDefinitions().filter((tool) => (
      tool.name === SESSION_CONTROL_INTERACTION_REQUEST
    ));
  const toolCodec = createProviderToolCodec(
    runtimeTools,
    controlTools,
    input.runtime.providerToolAliases,
    input.workspaceBindings,
  );
  const journalMessages = messagesFromJournal(input.events, input.runId, input.workspaceBindings);
  const contextMessages = (
    await Promise.all(input.contextProviders.map(async (provider) => (
      await provider.provide({ sessionId: input.sessionId, events: input.events })
    ).map<ContextMessageContribution>((message, index) => ({
      contributionId: `context-provider:${provider.id}:${index}`,
      contributionKind: 'contextProviders',
      label: provider.id,
      message: cloneModelMessage(message),
    }))))
  ).flat();
  const instructions = [...input.runtime.instructions]
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
    .map<ContextMessageContribution>((instruction) => ({
      contributionId: `instruction:${instruction.id}`,
      contributionKind: 'instructions',
      label: instruction.id,
      message: { role: 'system', content: instruction.text },
    }));
  const toolGuidance = renderActiveToolGuidance(
    input.runtime.toolPromptContributions,
    toolCodec.receiptTools,
    runtimeTools,
    hostedTools,
  );
  if (toolGuidance) {
    const stableCoreIndex = instructions.findIndex((instruction) => (
      instruction.contributionId === 'instruction:deepcode.coding-agent'
    ));
    if (stableCoreIndex < 0) {
      throw new LoopFailure(
        'stable_core_instruction_missing',
        'Run runtime 缺少唯一稳定 Core System Prompt。',
      );
    }
    instructions.splice(stableCoreIndex + 1, 0, {
      contributionId: 'instruction:deepcode.tool-guidance',
      contributionKind: 'instructions',
      label: 'deepcode.tool-guidance',
      message: { role: 'system', content: toolGuidance },
    });
  }
  instructions.push({
    contributionId: 'session:controls',
    contributionKind: 'sessionControls',
    label: 'Session control contract',
    message: {
      role: 'system',
      content: sessionControlInstructions(controlNames, hasWorkspaceBindings),
    },
  });
  instructions.push({
    contributionId: 'session:workspace-bindings',
    contributionKind: 'workspaceBindings',
    label: '当前运行的目录索引',
    message: {
      role: 'system',
      content: hasWorkspaceBindings
        ? `Current Session workspace bindings (logical handles only): ${JSON.stringify(
          providerWorkspaceBindings(prefixBindings),
        )}`
        : 'Current Session workspace bindings: []. Workspace-scoped filesystem and Bash tools are unavailable for this run.',
    },
  });
  const selected = await input.memory.select({
    events: input.events,
    messages: [...instructions, ...contextMessages, ...journalMessages],
  });
  assertContextContributions(selected);
  const journalCodecsByCallId = providerMessageCodecsByCallId(input.events);
  const providerSelected = selected.map<ContextMessageContribution>((contribution) => ({
    ...contribution,
    message: encodeProviderMessage(contribution.message, toolCodec, journalCodecsByCallId),
  }));
  const request: ProviderRequest = {
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    requestId: input.providerRequestId,
    sessionId: input.sessionId,
    runId: input.runId,
    providerRuntimeRef: input.runtime.provider.providerRuntimeRef,
    profileId: input.runtime.provider.profileId,
    purpose: 'agent',
    responseConstraint: input.responseConstraint,
    maxOutputTokens: input.runtime.provider.maxOutputTokens,
    workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
    messages: providerSelected.map((item) => cloneModelMessage(item.message)),
    tools: toolCodec.definitions,
    hostedTools,
  };
  const hostedReceiptTools: ContextCompositionTool[] = request.hostedTools.map((tool) => ({
    itemId: 'web.search',
    label: tool.providerToolType,
    canonicalName: 'web.search',
    wireName: tool.providerToolType,
    origin: 'providerHosted',
    availability: 'callable',
  }));
  return {
    request,
    toolCodec,
    receipt: buildContextCompositionReceipt(
      request.requestId,
      'agent',
      input.responseConstraint,
      providerSelected,
      toolCodec.kernelDefinitions,
      toolCodec.controlDefinitions,
      request.hostedTools,
      toolCodec.canonicalByWire,
      [...toolCodec.receiptTools, ...hostedReceiptTools],
      input.runtime,
      input.workspaceBindings,
      input.events,
    ),
  };
}

export function messagesFromJournal(
  events: readonly SessionEvent[],
  runId: string,
  workspaceBindings: readonly WorkspaceBindingDisplay[],
): ContextMessageContribution[] {
  const messages: ContextMessageContribution[] = [];
  const completionResults = new Map<string, ContextMessageContribution>();
  const orderedProviderTurns = new Map(events.flatMap((event) => (
    event.type === 'provider.turn.settled'
    && event.payload.outcome === 'completed'
    && event.payload.orderedOutputBlocks !== undefined
      ? [[event.payload.providerRequestId, event.payload.orderedOutputBlocks] as const]
      : []
  )));
  const orderedProviderCallIds = new Set([...orderedProviderTurns.values()].flatMap((blocks) => (
    blocks.flatMap((block) => block.kind === 'toolCall' ? [block.callId] : [])
  )));
  const providerCallIdByLogicalCallId = providerCallIdsFromEvents(events);
  const interactionCallIds = new Map(events.flatMap((event) => (
    event.type === 'interaction.requested'
      ? [[event.payload.interactionId, event.callId] as const]
      : []
  )));
  const retainedRunInputId = runInputMessageEvent(events, runId)?.payload.messageId;
  const runs = events.filter((event): event is Extract<SessionEvent, { type: 'run.started' }> => event.type === 'run.started');
  const runForInput = new Map(runs.map((event) => [event.payload.inputMessageId, event]));
  const checkpoint = [...events]
    .reverse()
    .find((event): event is Extract<SessionEvent, { type: 'context.compacted' }> => (
      event.type === 'context.compacted'
    ));
  if (checkpoint) {
    messages.push({
      contributionId: `context-checkpoint:${checkpoint.payload.compactionId}`,
      contributionKind: 'journalMessages',
      label: '上下文压缩摘要',
      message: { role: 'system', content: checkpoint.payload.summary },
    });
  }
  let todoList: TodoListProjection | null = null;
  for (const event of events) {
    todoList = advanceTodoList(todoList, event);
    if (
      checkpoint
      && event.sequence <= checkpoint.payload.coveredThroughSequence
      && !(event.type === 'message.committed' && event.payload.messageId === retainedRunInputId)
    ) continue;
    if (event.type === 'message.committed') {
      if (
        event.payload.role === 'assistant'
        && orderedProviderTurns.has(event.payload.providerRequestId)
      ) continue;
      const reasoning = event.payload.role === 'assistant'
        ? providerReasoning(events, event.payload.providerRequestId)
        : {};
      const inputRun = runForInput.get(event.payload.messageId);
      const messageBindings = inputRun?.payload.workspaceBindings ?? workspaceBindings;
      const previousRun = inputRun ? runs[runs.indexOf(inputRun) - 1] : undefined;
      if (inputRun && previousRun && JSON.stringify(inputRun.payload.workspaceBindings) !== JSON.stringify(previousRun.payload.workspaceBindings)) {
        messages.push({
          contributionId: `workspace-snapshot:${inputRun.runId}`, contributionKind: 'workspaceBindings',
          label: '本轮目录与资源引用', message: { role: 'system',
            content: `Current Session workspace bindings (logical handles only; supersedes earlier binding snapshots): ${JSON.stringify(providerWorkspaceBindings(messageBindings))}` },
        });
      }
      messages.push({
        contributionId: `message:${event.payload.messageId}`,
        contributionKind: 'journalMessages',
        label: event.payload.role === 'user' ? '用户消息' : 'Assistant 消息',
        message: {
          role: event.payload.role,
          content: messageContentForModel(event.payload, messageBindings),
          ...reasoning,
        },
      });
    } else if (event.type === 'narrative.committed') {
      if (orderedProviderTurns.has(event.payload.providerRequestId)) continue;
      if (!mergeNarrativeIntoProviderCall(messages, events, event)) {
        messages.push({
          contributionId: `narrative:${event.payload.narrativeId}`,
          contributionKind: 'journalMessages',
          label: '运行叙述',
          message: {
            role: 'assistant',
            content: event.payload.content,
            ...providerReasoning(events, event.payload.providerRequestId),
          },
        });
      }
    } else if (event.type === 'interaction.requested') {
      if (orderedProviderCallIds.has(event.callId)) continue;
      attachToolCall(messages, {
        callId: event.callId,
        providerCallId: event.payload.providerCallId,
        name: SESSION_CONTROL_INTERACTION_REQUEST,
        input: {
          kind: event.payload.kind,
          prompt: event.payload.prompt,
          options: event.payload.options,
          allowFreeform: event.payload.allowFreeform,
        },
      });
    } else if (event.type === 'interaction.resolved') {
      const callId = interactionCallIds.get(event.payload.interactionId);
      if (!callId) {
        throw new LoopFailure('interaction_call_identity_missing', '交互请求缺少 LogicalCallId。');
      }
      messages.push({
        contributionId: `interaction-result:${event.payload.interactionId}`,
        contributionKind: 'journalMessages',
        label: '用户交互答复',
        message: {
          role: 'tool',
          toolCallId: callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, callId),
          content: JSON.stringify({ response: event.payload.response }),
        },
      });
    } else if (event.type === 'plan.published') {
      if (orderedProviderCallIds.has(event.callId)) continue;
      attachToolCall(messages, {
        callId: event.callId,
        providerCallId: event.payload.providerCallId,
        name: SESSION_CONTROL_PLAN_PUBLISH,
        input: {
          title: event.payload.title,
          summary: event.payload.summary,
          steps: event.payload.steps,
          mutationManifest: event.payload.mutationManifest,
        },
      });
    } else if (event.type === 'plan.confirmed') {
      messages.push({
        contributionId: `plan-result:${event.payload.planId}:${event.payload.revision}`,
        contributionKind: 'journalMessages',
        label: '用户确认 Plan',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            response: { kind: 'confirm' },
            planId: event.payload.planId,
            revision: event.payload.revision,
            todoSeeded: true,
            nextAction: confirmedPlanExecutionInstruction(),
          }),
        },
      });
    } else if (event.type === 'plan.revision.requested') {
      messages.push({
        contributionId: `plan-revision-result:${event.payload.planId}:${event.payload.revision}`,
        contributionKind: 'journalMessages',
        label: '用户请求修改 Plan',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            response: { kind: 'requestRevision', text: event.payload.text },
            planId: event.payload.planId,
            revision: event.payload.revision,
          }),
        },
      });
    } else if (event.type === 'plan.cancelled') {
      messages.push({
        contributionId: `plan-cancel-result:${event.payload.planId}:${event.payload.revision}`,
        contributionKind: 'journalMessages',
        label: '用户取消 Plan',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({
            response: { kind: 'cancel' },
            planId: event.payload.planId,
            revision: event.payload.revision,
          }),
        },
      });
    } else if (event.type === 'plan.invalidated') {
      messages.push({
        contributionId: `plan-invalidated:${event.payload.planId}:${event.payload.revision}:${event.eventId}`,
        contributionKind: 'journalMessages',
        label: 'Plan 已失效',
        message: {
          role: 'system',
          content: JSON.stringify({
            type: 'plan.invalidated',
            planId: event.payload.planId,
            revision: event.payload.revision,
            reason: event.payload.reason,
            sourceFactRef: event.payload.sourceFactRef,
          }),
        },
      });
    } else if (
      event.type === 'todo.seeded'
      || event.type === 'todo.reconciled'
      || event.type === 'todo.progressed'
    ) {
      if (event.type === 'todo.progressed' && event.callId && event.payload.providerCallId) {
        if (!orderedProviderCallIds.has(event.callId)) attachToolCall(messages, {
          callId: event.callId, providerCallId: event.payload.providerCallId,
          name: SESSION_CONTROL_PLAN_PROGRESS,
          input: { sourceFactRef: event.payload.sourceFactRef, updates: event.payload.updates },
        });
        completionResults.set(event.callId, {
          contributionId: `plan-progress:${event.callId}`,
          contributionKind: 'journalMessages', label: 'Plan progress result',
          message: {
            role: 'tool', toolCallId: event.callId, providerCallId: event.payload.providerCallId,
            content: JSON.stringify({ accepted: true, type: 'todo.current', ...todoList }),
          },
        });
        continue;
      }
      if (todoList) messages.push({
        contributionId: `todo-state:${event.eventId}`,
        contributionKind: 'journalMessages',
        label: 'Session Todo state',
        message: {
          role: 'user',
          content: JSON.stringify({
            type: 'todo.current',
            sourcePlanId: todoList.sourcePlanId,
            sourcePlanRevision: todoList.sourcePlanRevision,
            items: todoList.items,
          }),
        },
      });
    } else if (event.type === 'plan.completed') {
      messages.push({
        contributionId: `plan-completed:${event.eventId}`,
        contributionKind: 'journalMessages', label: 'Plan phase completed',
        message: {
          role: 'user',
          content: JSON.stringify({
            type: 'plan.completed', ...event.payload,
            nextAction: 'All current Todo steps are completed. Plan progress is closed. Provide the final explanation; publish a complete revision only if new scope is required.',
          }),
        },
      });
    } else if (event.type === 'session.control.rejected') {
      if (!orderedProviderCallIds.has(event.callId)) {
        attachToolCall(messages, {
          callId: event.callId,
          providerCallId: event.payload.providerCallId,
          name: event.payload.toolName,
          input: event.payload.input,
        });
      }
      completionResults.set(event.callId, {
        contributionId: `session-control-rejection:${event.callId}`,
        contributionKind: 'journalMessages',
        label: 'Session control 拒绝结果',
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: event.payload.providerCallId,
          content: JSON.stringify({ accepted: false, executed: false, error: event.payload.error }),
        },
      });
    } else if (event.type === 'tool.requested') {
      if (orderedProviderCallIds.has(event.callId)) continue;
      attachToolCall(messages, {
        callId: event.callId,
        providerCallId: event.payload.providerCallId,
        name: event.payload.toolName,
        input: event.payload.input,
      });
    } else if (event.type === 'tool.input-rejected') {
      messages.push({
        contributionId: `tool-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: `${event.payload.rejection.toolName} input rejected`,
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify({ status: 'inputRejected', executed: false, error: event.payload.rejection.error }),
        },
      });
    } else if (event.type === 'tool.completed') {
      messages.push({
        contributionId: `tool-result:${event.callId}`,
        contributionKind: 'journalMessages',
        label: `${event.payload.record.preparedEffect.operation} 结果`,
        message: {
          role: 'tool',
          toolCallId: event.callId,
          providerCallId: requiredProviderCallId(providerCallIdByLogicalCallId, event.callId),
          content: JSON.stringify(toolResultForModel(event.payload.record)),
        },
      });
    } else if (event.type === 'provider.turn.settled' && event.payload.outcome === 'completed') {
      if (event.payload.orderedOutputBlocks !== undefined) {
        messages.push({
          contributionId: `provider-output:${event.payload.providerRequestId}`,
          contributionKind: 'journalMessages',
          label: 'Provider output',
          message: {
            role: 'assistant',
            content: '',
            providerOutputBlocks: event.payload.orderedOutputBlocks.map((block) => ({
              ...block,
              item: structuredClone(block.item),
            })),
          },
        });
        for (const block of event.payload.orderedOutputBlocks) {
          if (block.kind !== 'toolCallRejected') continue;
          messages.push({
            contributionId: `provider-input-rejection:${block.callId}`,
            contributionKind: 'journalMessages',
            label: `${block.toolName} input rejected`,
            message: {
              role: 'tool',
              toolCallId: block.callId,
              providerCallId: block.providerCallId,
              content: JSON.stringify({ status: 'inputRejected', executed: false, error: block.error }),
            },
          });
        }
      }
      for (const callId of event.payload.orderedCallIds) {
        const result = completionResults.get(callId);
        if (!result) continue;
        messages.push(result);
        completionResults.delete(callId);
      }
    }
  }
  if (completionResults.size > 0) {
    throw new LoopFailure(
      'provider_call_result_completion_missing',
      'Session control 结果缺少对应的 Provider turn 完成事实。',
    );
  }
  applyProviderTurnCompletions(messages, events);
  return messages;
}

function advanceTodoList(
  todoList: TodoListProjection | null,
  event: SessionEvent,
): TodoListProjection | null {
  if (event.type === 'todo.seeded' || event.type === 'todo.reconciled') {
    return {
      sourcePlanId: event.payload.sourcePlanId,
      sourcePlanRevision: event.payload.sourcePlanRevision,
      items: event.payload.items.map((item) => ({ ...item })),
      sequence: event.sequence,
      updatedAt: event.occurredAt,
    };
  }
  if (event.type !== 'todo.progressed' || !todoList) return todoList;
  if (
    todoList.sourcePlanId !== event.payload.sourcePlanId
    || todoList.sourcePlanRevision !== event.payload.sourcePlanRevision
  ) throw new LoopFailure('todo_source_plan_mismatch', 'Session Todo 当前状态来源不一致。');
  const updates = new Map(event.payload.updates.map((update) => [update.todoId, update.status]));
  return {
    ...todoList,
    items: todoList.items.map((item) => ({
      ...item,
      status: updates.get(item.todoId) ?? item.status,
    })),
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}

export function buildContextCompositionReceipt(
  providerRequestId: string,
  purpose: ContextCompositionReceipt['purpose'],
  responseConstraint: ContextCompositionReceipt['responseConstraint'],
  selected: readonly ContextMessageContribution[],
  kernelTools: readonly ProviderToolDefinition[],
  controlTools: readonly ProviderToolDefinition[],
  hostedTools: readonly ProviderRequest['hostedTools'][number][],
  canonicalByWire: ReadonlyMap<string, string>,
  receiptTools: readonly ContextCompositionTool[],
  runtime: RunRuntimeSnapshot,
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  events: readonly SessionEvent[],
): ContextCompositionReceipt {
  const filesystemReferenceFactsByContributionId = new Map<string, Array<{
    referenceId: string;
    displayName: string;
  }>>();
  for (const event of events) {
    if (event.type !== 'message.committed') continue;
    const references = (event.payload.filesystemReferences ?? []).map((reference) => ({
      referenceId: reference.referenceId,
      displayName: reference.displayName,
    }));
    if (references.length > 0) {
      filesystemReferenceFactsByContributionId.set(
        `message:${event.payload.messageId}`,
        references,
      );
    }
  }
  const workspaceBindingItems = workspaceBindings.map((binding) => ({
    itemId: binding.workspaceId,
    label: binding.displayName,
  }));
  const toolItems = receiptTools.map((tool) => ({ ...tool }));
  if (toolItems.length !== kernelTools.length + controlTools.length + hostedTools.length) {
    throw new LoopFailure('provider_tool_receipt_incomplete', 'Context receipt 工具数量不完整。');
  }
  for (const tool of toolItems) {
    if (tool.origin === 'providerHosted') {
      if (tool.canonicalName !== 'web.search' || tool.wireName !== 'web_search') {
        throw new LoopFailure(
          'provider_hosted_tool_receipt_invalid',
          'Context receipt 的 Provider hosted search 工具无效。',
        );
      }
      continue;
    }
    if (canonicalByWire.get(tool.wireName) !== tool.canonicalName) {
      throw new LoopFailure(
        'provider_tool_alias_receipt_missing',
        `Context receipt 缺少 Provider tool alias：${tool.canonicalName}`,
      );
    }
  }
  const messages = selected.map((item, messageIndex) => ({
    messageIndex,
    contributionId: item.contributionId,
    contributionKind: item.contributionKind,
    label: item.label,
    role: item.message.role,
    blocks: contextCompositionBlocks(item.message),
    filesystemReferences: (
      filesystemReferenceFactsByContributionId.get(item.contributionId) ?? []
    ).map((reference) => ({
      itemId: reference.referenceId,
      label: reference.displayName,
    })),
  }));
  return {
    providerRequestId,
    purpose,
    responseConstraint,
    stableCoreHash: stableReceiptHash(stableCoreInstructions(runtime)),
    baseToolSchemaHash: stableReceiptHash(runtime.tools
      .filter((tool) => tool.origin === 'coreBuiltin')
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        possibleEffects: tool.possibleEffects,
        availability: tool.availability,
      }))),
    selectedPluginSnapshotHash: stableReceiptHash(runtime.selectedPlugins),
    dynamicInstructionBytes: selected.reduce((total, contribution) => (
      contribution.message.role === 'system'
      && contribution.contributionId !== 'instruction:deepcode.coding-agent'
        ? total + new TextEncoder().encode(contribution.message.content).byteLength
        : total
    ), 0),
    messages,
    workspaceBindings: workspaceBindingItems,
    tools: toolItems,
    partitions: buildContextCompositionPartitions(
      selected,
      kernelTools,
      controlTools,
      hostedTools,
      workspaceBindings,
      filesystemReferenceFactsByContributionId,
    ),
  };
}

function stableCoreInstructions(runtime: RunRuntimeSnapshot): readonly { id: string; text: string }[] {
  const instructions = runtime.instructions.filter((instruction) => (
    instruction.id === 'deepcode.coding-agent'
  ));
  if (instructions.length !== 1) {
    throw new LoopFailure(
      'stable_core_instruction_missing',
      'Run runtime 缺少唯一稳定 Core System Prompt。',
    );
  }
  return instructions;
}

function stableReceiptHash(value: unknown): string {
  const encoded = JSON.stringify(canonicalJsonValue(value));
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    left = Math.imul((left ^ code) >>> 0, 0x01000193) >>> 0;
    right = Math.imul((right ^ code ^ index) >>> 0, 0x85ebca6b) >>> 0;
  }
  return `context-hash-v1:${left.toString(16).padStart(8, '0')}${right
    .toString(16)
    .padStart(8, '0')}`;
}

export function assertContextContributions(
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

export function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            input: structuredClone(call.input),
          })),
        }
      : {}),
    ...(message.providerItems
      ? { providerItems: message.providerItems.map((item) => structuredClone(item)) }
      : {}),
    ...(message.providerOutputBlocks
      ? {
          providerOutputBlocks: message.providerOutputBlocks.map((block) => ({
            ...block,
            item: structuredClone(block.item),
          })),
        }
      : {}),
  };
}

function providerCallIdsFromEvents(events: readonly SessionEvent[]): Map<string, string> {
  const byLogicalCallId = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'todo.progressed' && event.callId && event.payload.providerCallId) {
      byLogicalCallId.set(event.callId, event.payload.providerCallId);
      continue;
    }
    if (
      event.type !== 'tool.requested'
      && event.type !== 'interaction.requested'
      && event.type !== 'plan.published'
      && event.type !== 'session.control.rejected'
    ) continue;
    const providerCallId = event.payload.providerCallId;
    const existing = byLogicalCallId.get(event.callId);
    if (existing !== undefined && existing !== providerCallId) {
      throw new LoopFailure(
        'provider_call_identity_conflict',
        `LogicalCallId ${event.callId} 对应了多个 ProviderCallId。`,
      );
    }
    byLogicalCallId.set(event.callId, providerCallId);
  }
  return byLogicalCallId;
}

function requiredProviderCallId(
  providerCallIds: ReadonlyMap<string, string>,
  logicalCallId: string,
): string {
  const providerCallId = providerCallIds.get(logicalCallId);
  if (!providerCallId) {
    throw new LoopFailure(
      'provider_call_identity_missing',
      `LogicalCallId ${logicalCallId} 缺少 ProviderCallId。`,
    );
  }
  return providerCallId;
}

export function runInputMessageEvent(
  events: readonly SessionEvent[],
  runId: string,
): Extract<SessionEvent, { type: 'message.committed' }> | null {
  const started = events.find((event): event is Extract<SessionEvent, { type: 'run.started' }> => (
    event.type === 'run.started' && event.runId === runId
  ));
  if (!started) return null;
  return events.find((event): event is Extract<SessionEvent, { type: 'message.committed' }> => (
    event.type === 'message.committed'
    && event.payload.messageId === started.payload.inputMessageId
  )) ?? null;
}

function providerReasoning(
  events: readonly SessionEvent[],
  providerRequestId: string,
): Pick<ModelMessage, 'reasoningContent' | 'reasoningSignature' | 'providerItems'> {
  const completion = events.find((event): event is CompletedProviderTurnEvent => (
    isCompletedProviderTurn(event)
    && event.payload.providerRequestId === providerRequestId
  ));
  if (!completion) {
    throw new LoopFailure(
      'provider_message_completion_missing',
      `Provider 输出消息缺少完成事实：${providerRequestId}`,
    );
  }
  return {
    ...(completion.payload.reasoningContent !== undefined
      ? { reasoningContent: completion.payload.reasoningContent }
      : {}),
    ...(completion.payload.reasoningSignature !== undefined
      ? { reasoningSignature: completion.payload.reasoningSignature }
      : {}),
    ...(completion.payload.hostedWebSearchCalls !== undefined
      ? {
          providerItems: completion.payload.hostedWebSearchCalls
            .map((item) => structuredClone(item)),
        }
      : {}),
  };
}

function mergeNarrativeIntoProviderCall(
  messages: ContextMessageContribution[],
  events: readonly SessionEvent[],
  narrative: Extract<SessionEvent, { type: 'narrative.committed' }>,
): boolean {
  const completion = events.find((event): event is CompletedProviderTurnEvent => (
    isCompletedProviderTurn(event)
    && event.runId === narrative.runId
    && event.payload.providerRequestId === narrative.payload.providerRequestId
  ));
  if (!completion) {
    throw new LoopFailure(
      'provider_message_completion_missing',
      `Provider narrative 缺少完成事实：${narrative.payload.providerRequestId}`,
    );
  }
  if (completion.payload.orderedCallIds.length === 0) return false;
  const callIds = new Set(completion.payload.orderedCallIds);
  const targets = messages.filter((contribution) => (
    contribution.message.toolCalls?.some((call) => callIds.has(call.callId))
  ));
  if (targets.length !== 1) {
    throw new LoopFailure(
      'provider_turn_call_projection_split',
      '同一 Provider turn 的 narrative 与工具调用没有投影到唯一 Assistant 消息。',
    );
  }
  targets[0]!.contributionId = `narrative:${narrative.payload.narrativeId}`;
  targets[0]!.label = '运行叙述';
  targets[0]!.message.content = narrative.payload.content;
  return true;
}

function isCompletedProviderTurn(event: SessionEvent): event is CompletedProviderTurnEvent {
  return event.type === 'provider.turn.settled' && event.payload.outcome === 'completed';
}

function applyProviderTurnCompletions(
  messages: ContextMessageContribution[],
  events: readonly SessionEvent[],
): void {
  const messageByCallId = new Map<string, ModelMessage>();
  for (const contribution of messages) {
    for (const call of contribution.message.toolCalls ?? []) {
      if (messageByCallId.has(call.callId)) {
        throw new LoopFailure('provider_call_projection_duplicate', '同一 LogicalCallId 被重复投影。');
      }
      messageByCallId.set(call.callId, contribution.message);
    }
  }
  for (const event of events) {
    if (
      event.type !== 'provider.turn.settled'
      || event.payload.outcome !== 'completed'
      || event.payload.purpose !== 'agent'
    ) continue;
    const turnMessages = new Set<ModelMessage>();
    let projectedCallCount = 0;
    for (const callId of event.payload.orderedCallIds) {
      const message = messageByCallId.get(callId);
      if (!message) continue;
      projectedCallCount += 1;
      turnMessages.add(message);
    }
    if (
      projectedCallCount > 0
      && projectedCallCount !== event.payload.orderedCallIds.length
    ) {
      throw new LoopFailure(
        'provider_turn_call_projection_partial',
        '上下文边界拆分了同一 Provider turn 的调用事实。',
      );
    }
    for (const message of turnMessages) {
      if (event.payload.reasoningContent !== undefined) {
        message.reasoningContent = event.payload.reasoningContent;
      }
      if (event.payload.reasoningSignature !== undefined) {
        message.reasoningSignature = event.payload.reasoningSignature;
      }
      if (event.payload.hostedWebSearchCalls !== undefined) {
        message.providerItems = event.payload.hostedWebSearchCalls
          .map((item) => structuredClone(item));
      }
    }
  }
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

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'filesystemReferences',
] as const;

function buildContextCompositionPartitions(
  selected: readonly ContextMessageContribution[],
  kernelTools: readonly ProviderToolDefinition[],
  controlTools: readonly ProviderToolDefinition[],
  hostedTools: readonly ProviderRequest['hostedTools'][number][],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
  filesystemReferenceFactsByContributionId: ReadonlyMap<string, readonly unknown[]>,
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
    const references = filesystemReferenceFactsByContributionId.get(contribution.contributionId)
      ?? [];
    const referenceUnits = Math.min(
      messageUnits,
      references.length ? jsonShapeUnits(references) : 0,
    );
    if (references.length > 0) {
      add('filesystemReferences', references.length, referenceUnits);
    }
    if (contribution.contributionKind === 'workspaceBindings') {
      add('workspaceBindings', workspaceBindings.length, messageUnits - referenceUnits);
    } else {
      add(contribution.contributionKind, 1, messageUnits - referenceUnits);
    }
  }
  add('sessionControls', controlTools.length, sumShapeUnits(controlTools));
  add(
    'tools',
    kernelTools.length + hostedTools.length,
    sumShapeUnits(kernelTools) + sumShapeUnits(hostedTools),
  );
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
      | { kind: 'toolResult'; resultForCallId: string }
      | { kind: 'hostedWebSearch'; providerCallId: string },
  ): void => {
    blocks.push({ ...block, blockIndex: blocks.length } as ContextCompositionMessage['blocks'][number]);
  };
  if (message.role === 'tool' && message.toolCallId) {
    append({ kind: 'toolResult', resultForCallId: message.toolCallId });
    return blocks;
  }
  if (message.providerOutputBlocks) {
    for (const block of message.providerOutputBlocks) {
      switch (block.kind) {
        case 'reasoning':
          append({ kind: 'reasoning' });
          break;
        case 'narrative':
        case 'finalMessage':
          append({ kind: 'text' });
          break;
        case 'toolCall':
        case 'toolCallRejected':
          append({ kind: 'toolCall', callId: block.callId, toolName: block.toolName });
          break;
        case 'providerHosted':
          append({ kind: 'hostedWebSearch', providerCallId: block.providerCallId });
          break;
      }
    }
    return blocks;
  }
  if (message.reasoningContent) append({ kind: 'reasoning' });
  for (const item of message.providerItems ?? []) {
    if (item.type === 'web_search_call' && typeof item.id === 'string') {
      append({ kind: 'hostedWebSearch', providerCallId: item.id });
    }
  }
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

function messageContentForModel(
  payload: Extract<SessionEvent, { type: 'message.committed' }>['payload'],
  workspaceBindings: readonly WorkspaceBindingDisplay[],
): string {
  const sections = [payload.content];
  if (payload.filesystemReferences?.length) {
    const workspaceHandleById = new Map(workspaceBindings.map((binding, index) => [
      binding.workspaceId,
      index === 0 ? 'primary' : `workspace${index + 1}`,
    ]));
    sections.push(`Filesystem references attached to this message. No file content is embedded here:\n${JSON.stringify(
      payload.filesystemReferences.map((reference) => ({
        referenceId: reference.referenceId,
        workspace: workspaceHandleById.get(reference.workspaceId) ?? 'unavailable',
        path: reference.logicalPath,
        displayName: reference.displayName,
        kind: reference.kind,
        ...(reference.kind === 'file'
          ? { mediaType: reference.mediaType, byteLength: reference.byteLength }
          : {}),
      })),
    )}`);
  }
  return sections.join('\n\n');
}

function toolResultForModel(record: ToolExecutionRecord): Record<string, unknown> {
  if (record.outcome === 'completed') {
    const output = structuredClone(record.output);
    if (isRecord(output)) { delete output.workspaceId; delete output.fileChanges; }
    return { recordId: record.recordId, outcome: record.outcome, output };
  }
  if (record.outcome === 'failed') {
    const output = record.output === undefined ? undefined : structuredClone(record.output);
    if (isRecord(output)) { delete output.workspaceId; delete output.fileChanges; }
    return {
      recordId: record.recordId,
      outcome: record.outcome,
      ...(output === undefined ? {} : { output }),
      error: record.error,
    };
  }
  if (record.outcome === 'indeterminate') {
    return { outcome: record.outcome, error: record.error };
  }
  return {
    outcome: record.outcome,
    ...('error' in record && record.error ? { error: record.error } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
