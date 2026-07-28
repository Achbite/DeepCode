import type {
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  KernelCommandEnvelope,
  KernelPlanAuthorizationReview,
  KernelReply,
  KernelToolCatalogSnapshot,
  KernelTaskIntentEnvelope,
} from '@deepcode/protocol';
import { canonicalJson, stableHash } from '../../cache/canonicalizer.js';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PlanProjectionState } from '../projection/planProjectionBuilder.js';
import {
  conversationPresentationLanguage,
  conversationPresentationLanguageBinding,
  localizedProjectionText,
  type ConversationPresentationLanguage,
  type ConversationPresentationLanguageState,
  type ProjectionLanguageBinding,
} from '../projection/conversationPresentationLanguage.js';
import {
  takeProviderCommitEvents,
  type ProviderCommitBufferState,
} from '../pipelines/providerCommitBuffer.js';

export interface ProviderPlanProposalState
  extends PlanProjectionState, ProviderCommitBufferState, ConversationPresentationLanguageState {
  runId: string;
  phase: string;
  workspaceBinding?: AgentWorkspaceBinding;
  stateContract?: { toolCatalogSnapshot?: KernelToolCatalogSnapshot };
  driverRequest?: { stateContract?: { toolCatalogSnapshot?: KernelToolCatalogSnapshot } };
}

export interface ProviderPlanProposalHandlerPorts<State extends ProviderPlanProposalState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  projectKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): AgentEvent[];
  taskPlanCardEvent(input: {
    state: State;
    proposal: ProposalEnvelope;
    authorizationReview: KernelPlanAuthorizationReview;
    ts: string;
    id: string;
  }): AgentEvent;
  diagnosticEvent(
    sessionId: string,
    content: string,
    ts: string,
    id: string,
    presentationBinding: ProjectionLanguageBinding
  ): AgentEvent;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'waiting_plan_review' | 'failed';
    status?: 'waiting' | 'failed';
    reason: 'plan_review';
    decisionOwner: {
      kind: 'plan';
      runId: string;
      targetId: string;
      planId: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
}

export class ProviderPlanProposalHandler<State extends ProviderPlanProposalState> {
  constructor(private readonly ports: ProviderPlanProposalHandlerPorts<State>) {}

  async handle(state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const planId = planIdFromProposal(proposal);
    const catalog = state.stateContract?.toolCatalogSnapshot
      ?? state.driverRequest?.stateContract?.toolCatalogSnapshot;
    if (!catalog) {
      return this.failPlanAuthorization(
        state,
        planId,
        'Kernel ToolCatalog snapshot is unavailable; Session cannot submit a plan intent without inventing tool authority.',
        []
      );
    }
    const intent = taskIntentEnvelope(state, proposal, planId, catalog);
    const reply = await this.ports.kernel({
      command: {
        kind: 'planAuthorizationSubmit',
        requestId: this.ports.createId('plan-authorization-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        intent,
      },
    });
    const kernelEvents = this.ports.projectKernelEvents(
      state.sessionId,
      reply,
      conversationPresentationLanguage(state)
    );
    const review = planAuthorizationReview(reply.events, planId);
    if (!reply.ok || !review) {
      return this.failPlanAuthorization(
        state,
        planId,
        reply.error?.message ?? 'Kernel did not return PlanAuthorizationReviewed.',
        kernelEvents
      );
    }
    if (review.status !== 'confirmable') {
      const diagnostics = review.diagnostics.join('; ')
        || `Kernel plan authorization status=${review.status}.`;
      return this.failPlanAuthorization(state, planId, diagnostics, kernelEvents);
    }
    state.phase = 'waiting_plan_review';
    return this.ports.append(state.sessionId, [
      ...takeProviderCommitEvents(state),
      ...kernelEvents,
      this.ports.taskPlanCardEvent({
        state,
        proposal,
        authorizationReview: review,
        ts: this.ports.now(),
        id: this.ports.createId('task-plan'),
      }),
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_plan_review',
        reason: 'plan_review',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: planId,
          planId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-waiting-plan'),
      }),
    ]);
  }

  private async failPlanAuthorization(
    state: State,
    planId: string,
    message: string,
    kernelEvents: AgentEvent[]
  ): Promise<AgentSessionResult> {
    state.phase = 'failed';
    const presentationBinding = conversationPresentationLanguageBinding(state);
    return this.ports.append(state.sessionId, [
      ...takeProviderCommitEvents(state),
      ...kernelEvents,
      this.ports.diagnosticEvent(
        state.sessionId,
        localizedProjectionText(presentationBinding.language, {
          zh: 'Kernel 计划授权失败，Session 已停止进入执行阶段（错误代码：plan_authorization_failed）。',
          en: `Kernel plan authorization failed: ${message}`,
          neutral: 'plan_authorization_failed',
        }),
        this.ports.now(),
        this.ports.createId('plan-authorization-failed'),
        presentationBinding
      ),
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'failed',
        status: 'failed',
        reason: 'plan_review',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: planId,
          planId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-plan-authorization-failed'),
      }),
    ]);
  }
}

function taskIntentEnvelope<State extends ProviderPlanProposalState>(
  state: State,
  proposal: ProposalEnvelope,
  planId: string,
  catalog: KernelToolCatalogSnapshot
): KernelTaskIntentEnvelope {
  const payload = objectRecord(proposal.payload) ?? {};
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  return {
    schemaVersion: 'deepcode.kernel.task-intent.v2',
    planId,
    planHash: stableHash(canonicalJson(payload)),
    runId: state.runId,
    sessionId: state.sessionId,
    workspaceBindingHash: workspaceBindingHash(state.workspaceBinding),
    catalogVersion: catalog.catalogVersion,
    catalogHash: catalog.catalogHash,
    tasks: tasks.flatMap((value, index) => {
      const task = objectRecord(value);
      if (!task) return [];
      const args = objectRecord(task.args);
      if (!args) {
        throw new Error(`taskPlan.tasks[${index}].args must be a canonical object.`);
      }
      return [{
        taskId: stringValue(task.taskId) ?? stringValue(task.id) ?? `task-${index + 1}`,
        toolId: stringValue(task.toolId) ?? '',
        targets: stringArray(task.target),
        dependsOn: stringArray(task.dependencies),
        args,
      }];
    }),
  };
}

function planAuthorizationReview(
  events: unknown[],
  planId: string
): KernelPlanAuthorizationReview | undefined {
  for (const value of events) {
    const event = objectRecord(value);
    if (event?.kind !== 'plan_authorization.reviewed') continue;
    if (stringValue(event.planId) !== planId) continue;
    const review = objectRecord(event.review);
    const contract = objectRecord(review?.authorizationContract);
    const status = stringValue(review?.status);
    if (!review || !contract || !status) return undefined;
    return review as unknown as KernelPlanAuthorizationReview;
  }
  return undefined;
}

function workspaceBindingHash(binding: AgentWorkspaceBinding | undefined): string | undefined {
  return binding?.workspaceHash ?? binding?.folderHash ?? binding?.workspaceId;
}

function planIdFromProposal(proposal: ProposalEnvelope): string {
  const payload = objectRecord(proposal.payload);
  return stringValue(payload?.id) ?? proposal.proposalId;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}
