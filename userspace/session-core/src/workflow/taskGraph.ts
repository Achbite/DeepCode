import type { AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../agent-plan/types.js';
import type { DriverRequestRef, KernelStateContractRef } from '../driver/types.js';

export type SessionTaskKind =
  | 'requirement'
  | 'resourceDiscovery'
  | 'guidance'
  | 'analysis'
  | 'planning'
  | 'waitingUser'
  | 'execution'
  | 'review'
  | 'continuation'
  | 'diagnostic';

export type SessionTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'blocked'
  | 'failed';

export interface SessionTaskState {
  id: string;
  kind: SessionTaskKind;
  status: SessionTaskStatus;
  title: string;
  summary: string;
  eventRefs: string[];
  dependsOn: string[];
}

export interface SessionTaskGraph {
  schemaVersion: '1';
  sessionId: string;
  runId?: string;
  activeTaskId?: string;
  tasks: SessionTaskState[];
  stateContractRef?: {
    stateId: string;
    allowedProposals: string[];
  };
  driverRequestRef?: {
    id: string;
    kind: string;
  };
}

export interface SessionTaskGraphInput {
  sessionId: string;
  runId?: string;
  events: AgentEvent[];
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  lastProposal?: ProposalEnvelope;
}

export function buildSessionTaskGraph(input: SessionTaskGraphInput): SessionTaskGraph {
  const tasks = new Map<string, SessionTaskState>();
  const upsert = (task: Omit<SessionTaskState, 'eventRefs' | 'dependsOn'> & { eventRef?: string; dependsOn?: string[] }) => {
    const existing = tasks.get(task.id);
    const eventRefs = [...(existing?.eventRefs ?? []), ...(task.eventRef ? [task.eventRef] : [])];
    tasks.set(task.id, {
      id: task.id,
      kind: task.kind,
      status: mergeTaskStatus(existing?.status, task.status),
      title: task.title,
      summary: task.summary,
      eventRefs: [...new Set(eventRefs)],
      dependsOn: [...new Set([...(existing?.dependsOn ?? []), ...(task.dependsOn ?? [])])],
    });
  };

  for (const event of input.events) {
    if (event.kind === 'user_guidance') {
      const guidanceId = eventPayloadString(event, 'guidanceId') ?? event.id;
      upsert({
        id: `guidance-${guidanceId}`,
        kind: 'guidance',
        status: eventPayloadString(event, 'status') === 'consumed' ? 'completed' : 'queued',
        title: 'User guidance',
        summary: eventSummary(event) || 'User guidance recorded for the next provider checkpoint.',
        eventRef: event.id,
      });
    }
    if (event.kind === 'requirement_confirmation' || event.kind === 'requirement_decision') {
      upsert({
        id: 'requirement',
        kind: 'requirement',
        status: event.kind === 'requirement_decision' ? 'completed' : 'waiting',
        title: 'Requirement',
        summary: eventSummary(event) || 'Requirement decision pending.',
        eventRef: event.id,
      });
    }
    if (event.kind === 'tool_call' || event.kind === 'tool_result') {
      const toolId = eventPayloadString(event, 'callId') ?? eventPayloadString(event, 'toolCallId') ?? eventPayloadString(event, 'toolName') ?? event.id;
      upsert({
        id: `resource-${toolId}`,
        kind: 'resourceDiscovery',
        status: event.kind === 'tool_result' ? eventStatus(event, 'completed') : 'running',
        title: eventPayloadString(event, 'toolName') ?? 'Resource discovery',
        summary: eventSummary(event) || 'Resource/tool fact.',
        eventRef: event.id,
      });
    }
    if (event.kind === 'plan_card') {
      const implementationTasks = implementationPlanTasks(event);
      if (implementationTasks.length) {
        for (const task of implementationTasks) {
          upsert({
            id: `implementation-${task.taskId}`,
            kind: 'planning',
            status: 'queued',
            title: task.title,
            summary: task.summary,
            eventRef: event.id,
            dependsOn: task.dependencies,
          });
        }
      }
    }
    if ((event.kind === 'plan_card' || event.kind === 'plan_review') && !eventIsDebug(event)) {
      upsert({
        id: 'planning',
        kind: 'planning',
        status: event.kind === 'plan_card' && planCardAwaitingDecision(event) ? 'waiting' : eventStatus(event, 'running'),
        title: 'Planning',
        summary: eventSummary(event) || 'Plan is being reviewed.',
        eventRef: event.id,
        dependsOn: taskExists(tasks, 'requirement') ? ['requirement'] : [],
      });
    }
    if (event.kind === 'permission_request' || event.kind === 'permission_result') {
      upsert({
        id: 'waiting-user',
        kind: 'waitingUser',
        status: event.kind === 'permission_result' ? 'completed' : 'waiting',
        title: 'User decision',
        summary: eventSummary(event) || 'Waiting for user decision.',
        eventRef: event.id,
      });
    }
    if (event.kind === 'workflow_stage' || event.kind === 'workflow_decision') {
      upsert({
        id: 'execution',
        kind: 'execution',
        status: eventStatus(event, 'running'),
        title: 'Execution',
        summary: eventSummary(event) || 'Kernel workflow progress.',
        eventRef: event.id,
        dependsOn: taskExists(tasks, 'planning') ? ['planning'] : [],
      });
    }
    if (event.kind === 'review_summary') {
      const status = eventPayloadString(event, 'status');
      upsert({
        id: 'review',
        kind: 'review',
        status: status === 'accepted' ? 'completed' : status === 'needsRevision' ? 'waiting' : 'running',
        title: 'Review',
        summary: eventSummary(event) || 'Review round.',
        eventRef: event.id,
        dependsOn: taskExists(tasks, 'execution') ? ['execution'] : [],
      });
      if (eventHasContinuation(event)) {
        upsert({
          id: 'continuation',
          kind: 'continuation',
          status: 'queued',
          title: 'Continuation',
          summary: 'Continuation intent recorded for a later reviewable batch.',
          eventRef: event.id,
          dependsOn: ['review'],
        });
      }
    }
    if (event.kind === 'assistant_msg') {
      const channel = eventPayloadString(event, 'channel');
      if (channel === 'final') {
        upsert({
          id: 'analysis',
          kind: 'analysis',
          status: 'completed',
          title: 'Analysis',
          summary: eventSummary(event) || 'Final answer produced.',
          eventRef: event.id,
        });
      }
    }
    if (event.kind === 'error') {
      upsert({
        id: 'diagnostic',
        kind: 'diagnostic',
        status: 'failed',
        title: 'Diagnostic',
        summary: eventSummary(event) || 'Session diagnostic.',
        eventRef: event.id,
      });
    }
  }

  if (input.lastProposal) {
    const id = proposalTaskId(input.lastProposal);
    upsert({
      id,
      kind: proposalTaskKind(input.lastProposal),
      status: proposalTaskStatus(input.lastProposal),
      title: 'Latest proposal',
      summary: `Latest proposal kind=${input.lastProposal.kind}.`,
    });
  }

  const list = [...tasks.values()];
  return {
    schemaVersion: '1',
    sessionId: input.sessionId,
    runId: input.runId,
    activeTaskId: activeTaskId(list),
    tasks: list,
    stateContractRef: input.stateContract
      ? {
        stateId: input.stateContract.stateId,
        allowedProposals: [...input.stateContract.allowedProposals],
      }
      : undefined,
    driverRequestRef: input.driverRequest
      ? {
        id: input.driverRequest.id,
        kind: input.driverRequest.kind,
      }
      : undefined,
  };
}

function activeTaskId(tasks: SessionTaskState[]): string | undefined {
  return tasks.find((task) => task.status === 'running')?.id
    ?? tasks.find((task) => task.status === 'waiting')?.id
    ?? tasks.find((task) => task.status === 'queued')?.id;
}

function proposalTaskId(proposal: ProposalEnvelope): string {
  if (proposal.kind === 'resourceRequest') return 'resource-request-proposal';
  if (proposal.kind === 'decisionRequest') return 'requirement';
  if (proposal.kind === 'implementationPlan') return 'planning';
  if (proposal.kind === 'actionBundle') return 'planning';
  if (proposal.kind === 'diagnostic') return 'diagnostic';
  return 'analysis';
}

function proposalTaskKind(proposal: ProposalEnvelope): SessionTaskKind {
  if (proposal.kind === 'resourceRequest') return 'resourceDiscovery';
  if (proposal.kind === 'decisionRequest') return 'requirement';
  if (proposal.kind === 'implementationPlan') return 'planning';
  if (proposal.kind === 'actionBundle') return 'planning';
  if (proposal.kind === 'diagnostic') return 'diagnostic';
  return 'analysis';
}

function proposalTaskStatus(proposal: ProposalEnvelope): SessionTaskStatus {
  if (proposal.kind === 'answer') return 'completed';
  if (proposal.kind === 'diagnostic') return 'failed';
  if (proposal.kind === 'decisionRequest') return 'waiting';
  if (proposal.kind === 'implementationPlan') return 'waiting';
  return 'running';
}

function mergeTaskStatus(previous: SessionTaskStatus | undefined, next: SessionTaskStatus): SessionTaskStatus {
  if (!previous) return next;
  if (next === 'failed' || previous === 'failed') return 'failed';
  return next;
}

function taskExists(tasks: Map<string, SessionTaskState>, id: string): boolean {
  return tasks.has(id);
}

function eventStatus(event: AgentEvent, fallback: SessionTaskStatus): SessionTaskStatus {
  const status = eventPayloadString(event, 'status') ?? eventPayloadString(event, 'decision');
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'awaitingUserApproval' || status === 'awaitingTemporaryGrant' || status === 'pending' || status === 'waiting') return 'waiting';
  if (status === 'completed' || status === 'done' || status === 'ok' || status === 'accepted') return 'completed';
  if (status === 'running' || status === 'started') return 'running';
  return fallback;
}

function eventSummary(event: AgentEvent): string {
  return eventPayloadString(event, 'summary')
    ?? eventPayloadString(event, 'message')
    ?? eventPayloadString(event, 'content')
    ?? eventPayloadString(event, 'details')
    ?? eventPayloadString(event, 'toolName')
    ?? '';
}

function eventPayloadString(event: AgentEvent, key: string): string | undefined {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return undefined;
  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function eventPayloadBoolean(event: AgentEvent, key: string): boolean | undefined {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return undefined;
  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function eventIsDebug(event: AgentEvent): boolean {
  return event.kind.startsWith('trace/') || eventPayloadString(event, 'visibility') === 'debug';
}

function planCardAwaitingDecision(event: AgentEvent): boolean {
  if (eventPayloadBoolean(event, 'confirmable') === false) return false;
  const status = eventPayloadString(event, 'status');
  if (!status) return true;
  return status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending';
}

function eventHasContinuation(event: AgentEvent): boolean {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false;
  const payload = event.payload as Record<string, unknown>;
  const continuations = payload.continuations ?? payload.continuationExpectations;
  return Array.isArray(continuations) && continuations.length > 0;
}

function implementationPlanTasks(event: AgentEvent): Array<{
  taskId: string;
  title: string;
  summary: string;
  dependencies: string[];
}> {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
  const implementationPlan = payload?.implementationPlan && typeof payload.implementationPlan === 'object' && !Array.isArray(payload.implementationPlan)
    ? payload.implementationPlan as Record<string, unknown>
    : undefined;
  const tasks = Array.isArray(implementationPlan?.tasks) ? implementationPlan.tasks : [];
  return tasks.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const taskId = typeof record.taskId === 'string' && record.taskId.trim()
      ? record.taskId
      : `task-${index + 1}`;
    const title = typeof record.title === 'string' && record.title.trim()
      ? record.title
      : taskId;
    const scope = typeof record.scope === 'string' ? record.scope : '';
    const acceptance = Array.isArray(record.acceptanceCriteria)
      ? record.acceptanceCriteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const dependencies = Array.isArray(record.dependencies)
      ? record.dependencies.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    return [{
      taskId,
      title,
      summary: [scope, acceptance.length ? `Acceptance: ${acceptance.join('; ')}` : ''].filter(Boolean).join(' · '),
      dependencies,
    }];
  });
}
