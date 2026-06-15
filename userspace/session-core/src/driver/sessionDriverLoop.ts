import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
} from '@deepcode/protocol';
import { parseProposalEnvelope } from '../agent-plan/protocolV3.js';
import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type ProposalEnvelope,
  type ResourceRequestDraft,
} from '../agent-plan/types.js';
import type {
  InitialContextPacket,
  ConversationResourceRoot,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourceManifestEntry,
  ResourcePacket,
  ResourcePacketItem,
} from '../context/types.js';
import { buildPromptEnvelope } from '../prompt/builder.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type { RequirementChecklist, RequirementRecord } from '../requirement/types.js';
import type { TranscriptEntry } from '../transcript.js';
import type { DriverRequestRef, KernelStateContractRef } from './types.js';

export interface SessionDriverLoopPorts {
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  appendTranscript?: (sessionId: string, entry: TranscriptEntry) => Promise<void>;
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  llmChat(request: LlmChatRequest): Promise<ApiResponse<LlmChatResult>>;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface SessionDriverLoopInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  appendUserMessage?: boolean;
  confirmedRequirement?: RequirementRecord;
  requirementConfirmationMode?: RequirementConfirmationMode;
}

export type RequirementConfirmationMode = 'auto' | 'always' | 'off';

export interface SessionDecisionResolverInput {
  sessionId: string;
  kind: 'requirement' | 'plan' | 'review' | 'permission' | 'boundary';
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId?: string;
  targetId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
}

interface SessionDriverLoopRunState {
  sessionId: string;
  runId: string;
  userRequest: string;
  workspaceScopeKey: string;
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  initialContext: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  memoryHints: string[];
  implementationBatch: ImplementationBatchContext;
  resourceRequestRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
}

interface ImplementationBatchContext {
  batchIndex: number;
  recentPlanSummaries: string[];
  continuationSummaries: string[];
}

interface ResourceManifestBuildResult {
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
}

interface ResourceRequestResolution {
  manifest: ResourceManifest;
  unresolved: string[];
  ambiguous: string[];
  availableRoots: ConversationResourceRoot[];
}

const MAX_RESOURCE_ROUNDS = 4;
const MAX_DERIVED_MANIFEST_ENTRIES = 240;
const RESOURCE_MANIFEST_MAX_BYTES = 512 * 1024;
const MAX_ACTION_BUNDLE_ACTIONS = 6;
const MAX_ACTION_BUNDLE_CODE_BLOCKS = 4;
const MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 12 * 1024;
const MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES = 6 * 1024;
const SIDE_EFFECT_CAPABILITIES = new Set([
  'workspace.write',
  'workspace.create',
  'workspace.delete',
  'workspace.rename',
  'process.exec',
  'network.egress',
  'git.write',
  'browser.control',
]);

export class SessionDriverLoop {
  constructor(private readonly ports: SessionDriverLoopPorts) {}

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    if (input.kind === 'requirement') return this.resolveRequirementDecision(input);
    if (input.kind === 'plan') return this.resolvePlanDecision(input);
    if (input.kind === 'review') return this.resolveReviewDecision(input);
    return this.append(input.sessionId, [
      finalDiagnosticEvent(
        input.sessionId,
        `当前决策类型 ${input.kind} 尚未接入 Session DecisionResolver。`,
        this.ts(),
        this.id('decision-unsupported')
      ),
    ]);
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    const sessionId = input.sessionId;
    let lastResult = input.appendUserMessage === false
      ? await this.append(sessionId, [])
      : await this.append(sessionId, [
        this.event(sessionId, 'user_msg', {
          content: input.content,
          attachments: input.attachments ?? [],
          channel: 'user',
          visibility: 'conversation',
        }),
      ]);

    const runReply = await this.kernel({
      command: {
        kind: 'runCreate',
        requestId: this.id('run-create'),
        sessionId,
        input: {
          text: input.content,
          attachments: input.attachments ?? [],
        },
        workspaceBinding: input.workspaceBinding,
        profileRef: input.profileId ? { id: input.profileId, kind: 'llm' } : undefined,
        workflowRef: input.workflow ? { id: input.workflow } : undefined,
        runOverrides: undefined,
      },
    });
    lastResult = await this.appendProjectedKernelEvents(sessionId, runReply);
    const runId = firstString(runReply.events, 'runId') ?? this.id('run');
    const stateContract = findStateContract(runReply.events);
    const driverRequest = findDriverRequest(runReply.events);

    const manifestBuild = createManifest(input, this.id('resource-manifest'));
    const implementationBatch = buildImplementationBatchContext(input.existingEvents ?? []);
    const state: SessionDriverLoopRunState = {
      sessionId,
      runId,
      userRequest: input.content,
      workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
      stateContract,
      driverRequest,
      manifest: manifestBuild.manifest,
      conversationRoots: manifestBuild.conversationRoots,
      initialContext: {
        id: this.id('initial-context'),
        workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
        manifest: manifestBuild.manifest,
      },
      resourcePackets: [],
      memoryHints: [
        ...buildSessionMemoryDocument(input.existingEvents ?? []),
        ...implementationBatchHints(implementationBatch),
      ],
      implementationBatch,
      resourceRequestRepairAttempted: false,
      planReviewRepairAttempted: false,
    };

    if (state.manifest.entries.length > 0) {
      const packet = await this.resolveResources(state, state.manifest);
      state.resourcePackets.push(packet);
      addDiscoveredManifestEntries(state.manifest, packet);
      lastResult = await this.append(sessionId, [resourcePacketEvent(sessionId, packet, this.ts(), this.id('resource-context'))]);
    }

    if (shouldRequestRequirementConfirmation(input, state)) {
      try {
        const event = await this.buildRequirementConfirmation(input, state);
        return this.append(sessionId, [event]);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(sessionId, [
          finalDiagnosticEvent(
            sessionId,
            `需求理解确认生成失败：${message}`,
            this.ts(),
            this.id('requirement-confirmation-failed')
          ),
        ]);
      }
    }

    let rounds = 0;
    while (rounds <= MAX_RESOURCE_ROUNDS) {
      const prompt = buildPromptEnvelope({
        workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
        allowedProposals: state.stateContract?.allowedProposals ?? [
          'answer',
          'resourceRequest',
          'decisionRequest',
          'actionBundle',
          'diagnostic',
        ],
        capabilityCatalogSummary: (state.stateContract?.capabilityProjection ?? []).join('\n'),
        memoryHints: state.memoryHints,
        userRequest: input.content,
        initialContext: state.initialContext,
        resourcePackets: state.resourcePackets,
        conversationRoots: state.conversationRoots,
        requirement: input.confirmedRequirement,
        auditOnly: {
          runId: state.runId,
          sessionId,
        },
      });
      let proposal: ProposalEnvelope;
      try {
        proposal = await this.callProviderAndParse(input, state, prompt);
      } catch (error) {
        if (error instanceof SessionDriverLoopError) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              error.message,
              this.ts(),
              this.id(error.code)
            ),
          ]);
        }
        throw error;
      }
      if (proposal.kind === 'answer') {
        return this.append(sessionId, [answerEvent(sessionId, proposal, this.ts(), this.id('answer'))]);
      }
      if (proposal.kind === 'decisionRequest') {
        const requirement = requirementRecordFromProposal(proposal, input, state, this.ts());
        return this.append(sessionId, [
          requirementConfirmationEvent({
            sessionId,
            runId: state.runId,
            requirement,
            proposal,
            originalUserRequest: input.content,
            attachments: input.attachments ?? [],
            ts: this.ts(),
            id: this.id('decision-request'),
          }),
        ]);
      }
      if (proposal.kind === 'diagnostic') {
        const diagnostic = objectRecord(proposal.payload) ?? {};
        const summary = stringValue(diagnostic.summary)
          ?? stringValue(diagnostic.details)
          ?? '模型返回诊断信息，未生成计划或执行队列。';
        return this.append(sessionId, [
          finalDiagnosticEvent(sessionId, summary, this.ts(), this.id('diagnostic')),
        ]);
      }
      if (proposal.kind === 'resourceRequest') {
        if (rounds >= MAX_RESOURCE_ROUNDS) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              '资源请求轮次已达到安全上限，已停止继续读取上下文。请缩小附件范围或指定更具体的文件。',
              this.ts(),
              this.id('resource-budget')
            ),
          ]);
        }
        let subset = manifestForResourceRequest(state.manifest, proposal.payload as ResourceRequestDraft, state.conversationRoots);
        if (!subset.manifest.entries.length) {
          if (!state.resourceRequestRepairAttempted) {
            state.resourceRequestRepairAttempted = true;
            try {
              const repaired = await this.repairResourceRequest(input, state, prompt, proposal, subset);
              if (repaired.kind === 'answer') {
                return this.append(sessionId, [answerEvent(sessionId, repaired, this.ts(), this.id('answer'))]);
              }
              if (repaired.kind === 'resourceRequest') {
                subset = manifestForResourceRequest(state.manifest, repaired.payload as ResourceRequestDraft, state.conversationRoots);
              } else if (repaired.kind === 'actionBundle') {
                return this.submitActionProposal(input, state, prompt, repaired, lastResult);
              } else {
                return this.submitNonExecutableProposal(state, repaired, lastResult);
              }
            } catch (error) {
              const message = error instanceof SessionDriverLoopError ? error.message : String(error);
              return this.append(sessionId, [
                finalDiagnosticEvent(
                  sessionId,
                  `模型请求的资源无法在附件或项目目录中定位，且 repair 失败：${message}`,
                  this.ts(),
                  this.id('resource-repair-failed')
                ),
              ]);
            }
          }
        }
        if (!subset.manifest.entries.length) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              resourceResolutionDiagnostic(subset),
              this.ts(),
              this.id('resource-invalid')
            ),
          ]);
        }
        const packet = await this.resolveResources(state, subset.manifest);
        state.resourcePackets.push(packet);
        addDiscoveredManifestEntries(state.manifest, packet);
        lastResult = await this.append(sessionId, [resourcePacketEvent(sessionId, packet, this.ts(), this.id('resource-context'))]);
        rounds += 1;
        continue;
      }
      if (proposal.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, proposal, lastResult);
      }
      return this.submitNonExecutableProposal(state, proposal, lastResult);
    }

    return lastResult;
  }

  private async resolveRequirementDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const requirementId = input.targetId;
    const confirmation = findRequirementConfirmation(events, input.runId, requirementId);
    if (!confirmation) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/requirement_decision_noop', '该需求确认已处理或已过期。', this.ts(), this.id('requirement-noop'), {
          runId: input.runId,
          requirementId,
          decision: input.decision,
        }),
      ]);
    }

    const decisionEvent = requirementDecisionEvent(input.sessionId, confirmation, input.decision, input.guidance, this.ts(), this.id('requirement-decision'));
    let result = await this.append(input.sessionId, [decisionEvent]);
    if (input.decision === 'reject') return result;

    const originalRequest = requirementOriginalRequest(confirmation);
    const next = await this.runUserTurn({
      sessionId: input.sessionId,
      content: input.decision === 'revise' && input.guidance
        ? `${originalRequest}\n\n用户修订意见：${input.guidance}`
        : originalRequest,
      attachments: requirementAttachments(confirmation),
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      confirmedRequirement: input.decision === 'accept' ? requirementRecordFromEvent(confirmation, 'confirmed') : undefined,
      requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
    });

    if (input.decision !== 'accept') return next;
    const plan = latestExecutablePlan(next.events, input.runId);
    if (!plan || !planAutoExecutableAfterRequirement(plan)) return next;
    return this.resolvePlanDecision({
      ...input,
      kind: 'plan',
      decision: 'accept',
      targetId: plan.planId,
      runId: plan.runId,
      existingEvents: next.events,
    });
  }

  private async resolvePlanDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const plan = findPlanCard(events, input.runId, input.targetId);
    if (!plan || planAlreadyResolved(events, plan)) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/plan_accept_noop', '该计划已处理或已过期，没有再次提交执行。', this.ts(), this.id('plan-noop'), {
          runId: input.runId,
          planId: input.targetId,
          decision: input.decision,
        }),
      ]);
    }

    if (input.decision !== 'accept') {
      return this.append(input.sessionId, [
        planReviewDecisionEvent(input.sessionId, plan, input.decision === 'revise' ? 'needsRevision' : 'rejected', input.guidance, this.ts(), this.id('plan-decision')),
      ]);
    }

    let result = await this.append(input.sessionId, [
      planReviewDecisionEvent(input.sessionId, plan, 'accepted', '用户已确认计划，准备进入执行。', this.ts(), this.id('plan-accepted')),
    ]);
    const decisionReply = await this.kernel({
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.id('user-decision-plan'),
        runId: plan.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.id('decision-plan'),
          decisionKind: 'plan',
          targetId: plan.planId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
          },
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);

    const grantEvents: unknown[] = [];
    for (const grant of temporaryGrantsForPlan(plan)) {
      const grantReply = await this.kernel({
        command: {
          kind: 'permissionGrantTemporary',
          requestId: this.id('plan-temp-grant'),
          runId: plan.runId,
          grant,
        },
      });
      grantEvents.push(...(grantReply.events ?? []));
    }
    if (grantEvents.length) {
      result = await this.appendProjectedKernelEvents(input.sessionId, { ok: true, events: grantEvents });
    }

    const batchReply = await this.kernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: this.id('action-batch-submit'),
        runId: plan.runId,
        sessionId: input.sessionId,
        batch: {
          planId: plan.planId,
          actionBundle: plan.actionBundle,
          codeBlocks: plan.codeBlocks,
          commandBlocks: plan.commandBlocks,
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, batchReply);
    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('review-facts-get'),
        runId: plan.runId,
        sessionId: input.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, factsReply);
    return this.append(input.sessionId, [
      reviewSummaryEvent(
        input.sessionId,
        plan,
        [...(batchReply.events ?? []), ...(factsReply.events ?? [])],
        this.ts(),
        this.id('review-summary')
      ),
    ]) ?? result;
  }

  private async resolveReviewDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const review = findWaitingReview(events, input.runId);
    if (!review || reviewAlreadyResolved(events, review)) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/review_accept_noop', '该 Review 已处理或已过期，没有重复推进任务。', this.ts(), this.id('review-noop'), {
          runId: input.runId,
          decision: input.decision,
        }),
      ]);
    }

    if (input.decision !== 'accept') {
      let result = await this.append(input.sessionId, [
        reviewDecisionEvent(input.sessionId, review, 'needsRevision', input.guidance ?? '用户要求补充或修改。', false, this.ts(), this.id('review-revise')),
      ]);
      const decisionReply = await this.kernel({
        command: {
          kind: 'userDecisionSubmit',
          requestId: this.id('user-decision-review'),
          runId: review.runId,
          sessionId: input.sessionId,
          decision: {
            decisionId: this.id('decision-review'),
            decisionKind: 'review',
            targetId: review.reviewId,
            payload: {
              decision: input.decision,
              guidance: input.guidance,
              continuationRequested: true,
              revisionRequested: true,
            },
          },
        },
      });
      result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: reviewRevisionRequest(review, input.guidance),
        attachments: [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
      });
    }

    const accepted = reviewDecisionEvent(input.sessionId, review, 'accepted', acceptedReviewContent(review), false, this.ts(), this.id('review-accepted'));
    let result = await this.append(input.sessionId, [accepted]);
    const decisionReply = await this.kernel({
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.id('user-decision-review'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.id('decision-review'),
          decisionKind: 'review',
          targetId: review.reviewId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
            continuationRequested: false,
            continuationRecorded: review.continuations.length > 0,
          },
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
    const gateReply = await this.kernel({
      command: {
        kind: 'reviewGateEvaluate',
        requestId: this.id('review-gate-evaluate'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decision: input.decision,
          guidance: input.guidance,
        },
      },
    });
    return this.appendProjectedKernelEvents(input.sessionId, gateReply) ?? result;
  }

  private async buildRequirementConfirmation(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState
  ): Promise<AgentEvent> {
    const prompt = buildPromptEnvelope({
      workflowState: 'needDecisionRequest',
      allowedProposals: ['decisionRequest'],
      capabilityCatalogSummary: (state.stateContract?.capabilityProjection ?? []).join('\n'),
      memoryHints: state.memoryHints,
      userOverlay: [
        'Before proposing side-effect work, request user intervention only if a concrete decision is needed.',
        'Return kind="decisionRequest" only.',
        'Provide 2-3 clear options with one recommended option and impact descriptions.',
        'Do not output actionBundle yet.',
      ].join('\n'),
      userRequest: input.content,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    const proposal = await this.callProviderAndParse(input, state, prompt);
    if (proposal.kind !== 'decisionRequest') {
      throw new SessionDriverLoopError(
        'decision_request_expected',
        `Expected decisionRequest before side-effect planning, got ${proposal.kind}.`
      );
    }
    const requirement = requirementRecordFromProposal(proposal, input, state, this.ts());
    return requirementConfirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      ts: this.ts(),
      id: this.id('requirement-confirmation'),
    });
  }

  private async callProviderAndParse(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope> {
    let raw: string;
    try {
      raw = await this.llm(input.profileId, state, 'provider_call', [
        { role: 'system', content: prompt.stablePrefix },
        { role: 'user', content: prompt.dynamicSuffix },
      ]);
    } catch (error) {
      if (error instanceof SessionDriverLoopError
        && error.code === 'llm_empty_response'
        && shouldAttemptActionBundleCompactionRepair(state)) {
        await this.append(state.sessionId, [
          thinkingEvent(
            state.sessionId,
            '模型没有返回有效 JSON，Session 正在要求其缩小为下一批可审查 actionBundle。',
            this.ts(),
            this.id('action-bundle-compaction-repair')
          ),
        ]);
        const repairedRaw = await this.llm(
          input.profileId,
          state,
          'action_bundle_compaction_repair',
          actionBundleCompactionRepairMessages(prompt, state, 'LLM provider returned an empty response before emitting a JSON proposal.', '')
        );
        try {
          return parseAndValidateProposal({
            raw: repairedRaw,
            runId: state.runId,
            sessionId: state.sessionId,
            source: 'llm',
          });
        } catch (repairError) {
          throw new SessionDriverLoopError(
            'agent_protocol_repair_failed',
            `模型空响应 repair 后仍无法解析：${normalizeParseError(repairError).message}`
          );
        }
      }
      throw error;
    }
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      const parseError = normalizeParseError(error);
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          `模型输出需要按 Agent Protocol v3 修复：${parseError.message}`,
          this.ts(),
          this.id('protocol-repair')
        ),
      ]);
      const repairStage = parseError.code === 'action_bundle_budget_exceeded'
        ? 'action_bundle_budget_repair'
        : 'protocol_repair';
      const repairPrompt = parseError.code === 'action_bundle_budget_exceeded'
        ? actionBundleCompactionRepairMessages(prompt, state, parseError.message, raw)
        : repairMessages(prompt, state, raw, parseError);
      const repairedRaw = await this.llm(input.profileId, state, repairStage, repairPrompt);
      try {
        return parseAndValidateProposal({
          raw: repairedRaw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
        });
      } catch (repairError) {
        throw new SessionDriverLoopError(
          'agent_protocol_repair_failed',
          `模型输出不符合 Agent Protocol v3，repair 后仍无法解析：${normalizeParseError(repairError).message}`
        );
      }
    }
  }

  private async repairResourceRequest(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    resolution: ResourceRequestResolution
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(input.profileId, state, 'resource_request_repair', resourceRequestRepairMessages(prompt, state, proposal, resolution));
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'agent_protocol_repair_failed',
        `模型资源请求 repair 后仍无法解析：${normalizeParseError(error).message}`
      );
    }
  }

  private async resolveResources(
    state: SessionDriverLoopRunState,
    manifest: ResourceManifest
  ): Promise<ResourcePacket> {
    const reply = await this.kernel({
      command: {
        kind: 'resourceResolve',
        requestId: this.id('resource-resolve'),
        runId: state.runId,
        sessionId: state.sessionId,
        request: { manifest },
      },
    });
    const packet = findResourcePacket(reply.events);
    if (!packet) {
      throw new SessionDriverLoopError('resource_packet_missing', 'Kernel ResourceResolve did not produce a ResourcePacket.');
    }
    return packet;
  }

  private async submitActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    const actionBundle = readActionBundle(proposal);
    if (!actionBundle) return await this.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? fallback;
    const reviewReport = findPlanReviewReport(proposalReply.events);
    await this.appendProviderTrace(state, 'plan_review_report', {
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    });
    if (!reviewReport) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          'Kernel 未返回 actionBundle 的 proposal.reviewed 事件，Session 不会展示可确认计划。',
          this.ts(),
          this.id('plan-review-missing')
        ),
      ]);
    }
    if (reviewReport && planReviewNeedsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'Kernel PlanReview 要求补充计划证据，Session 正在进行一次受控 repair。',
          this.ts(),
          this.id('plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, proposal, reviewReport);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(state.sessionId, [
          finalDiagnosticEvent(
            state.sessionId,
            `计划需要修订，但模型 repair 失败：${message}`,
            this.ts(),
            this.id('plan-review-repair-failed')
          ),
        ]);
      }
      if (repaired.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }
    let result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    if (planReviewDenied(reviewReport)) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          `Kernel 拒绝该计划：${planReviewDiagnosticSummary(reviewReport)}`,
          this.ts(),
          this.id('plan-review-denied')
        ),
      ]);
    }
    const planCard = actionBundlePlanCardEvent(state, proposal, reviewReport, this.ts(), this.id('plan-card'));
    result = await this.append(state.sessionId, [planCard]);
    return result ?? fallback;
  }

  private async repairPlanReview(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    report: Record<string, unknown>
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(input.profileId, state, 'plan_review_repair', planReviewRepairMessages(prompt, state, proposal, report));
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'agent_protocol_repair_failed',
        `模型计划 repair 后仍无法解析：${normalizeParseError(error).message}`
      );
    }
  }

  private async submitNonExecutableProposal(
    state: SessionDriverLoopRunState,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    const result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    return result ?? fallback;
  }

  private async llm(
    profileId: string | undefined,
    state: SessionDriverLoopRunState,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string> {
    await this.append(state.sessionId, [
      thinkingEvent(
        state.sessionId,
        providerStageSummary(stage, 'request'),
        this.ts(),
        this.id(`thinking-${stage}`)
      ),
    ]);
    await this.appendProviderTrace(state, `${stage}.request`, { profileId, messages });
    const result = await this.ports.llmChat({
      profileId,
      messages,
      responseFormat: { type: 'json_object' },
    });
    if (!result.ok || !result.data) {
      throw new SessionDriverLoopError(
        'llm_chat_failed',
        result.message ?? result.error ?? 'LLM provider request failed.'
      );
    }
    await this.appendProviderTrace(state, `${stage}.response`, result.data);
    const reasoning = collectReasoning(result.data);
    if (reasoning.trim()) {
      await this.append(state.sessionId, [
        reasoningEvent(state.sessionId, reasoning, this.ts(), this.id(`reasoning-${stage}`)),
      ]);
    } else {
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          providerStageSummary(stage, 'response'),
          this.ts(),
          this.id(`thinking-${stage}-response`)
        ),
      ]);
    }
    const content = result.data.assistantMessage?.content
      ?? result.data.chunks
        .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
        .map((chunk) => chunk.content)
        .join('');
    if (!content.trim()) {
      throw new SessionDriverLoopError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return content;
  }

  private async appendProviderTrace(
    state: SessionDriverLoopRunState,
    stage: string,
    payload: unknown
  ): Promise<void> {
    await this.ports.appendTranscript?.(state.sessionId, {
      type: 'metadata',
      uuid: this.id(`provider-trace-${stage}`),
      sessionId: state.sessionId,
      kind: 'provider_trace',
      payload: {
        stage,
        runId: state.runId,
        payload: redactForArchive(payload),
      },
      createdAt: this.ts(),
    });
  }

  private async kernel(request: KernelCommandEnvelope): Promise<KernelReply> {
    const reply = await this.ports.kernelCommand(request);
    if (!reply.ok) {
      throw new SessionDriverLoopError(
        reply.error?.code ?? 'kernel_command_failed',
        reply.error?.message ?? 'Kernel command failed.'
      );
    }
    return reply;
  }

  private async append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult> {
    return this.ports.appendEvents(sessionId, events);
  }

  private async appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult> {
    const events = (reply.events ?? []).map((event) => projectKernelEvent(sessionId, event, this.ts(), this.id('kernel')));
    if (events.length === 0) {
      return this.ports.appendEvents(sessionId, []);
    }
    return this.append(sessionId, events);
  }

  private event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
    return {
      id: this.id(kind),
      sessionId,
      ts: this.ts(),
      kind,
      payload,
    };
  }

  private id(prefix: string): string {
    return this.ports.createId?.(prefix) ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private ts(): string {
    return this.ports.now?.() ?? new Date().toISOString();
  }
}

export class SessionDriverLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionDriverLoopError';
  }
}

function createManifest(input: SessionDriverLoopInput, id: string): ResourceManifestBuildResult {
  const entries: ResourceManifestEntry[] = [];
  const conversationRoots: ConversationResourceRoot[] = [];
  const seenEntryRefs = new Set<string>();
  const seenRootRefs = new Set<string>();

  const addAttachment = (
    attachment: AgentContextAttachment,
    index: number,
    source: ConversationResourceRoot['source'],
    reason: string,
    addToManifest = true
  ) => {
    if (attachment.kind !== 'file' && attachment.kind !== 'directory') return;
    const resourceRef = attachment.absolutePath ?? attachment.path;
    if (!resourceRef) return;
    const refKey = comparablePath(resourceRef);
    if (!addToManifest && seenRootRefs.has(refKey)) return;
    if (addToManifest && seenEntryRefs.has(refKey) && seenRootRefs.has(refKey)) return;
    const entry: ResourceManifestEntry = {
      id: manifestEntryId(attachment, index, source),
      kind: attachment.kind,
      label: `${attachment.kind === 'directory' ? 'Directory' : 'File'} ${attachment.path || resourceRef}`,
      resourceRef,
      readPolicy: 'autoRead',
      reason,
    };
    if (addToManifest && !seenEntryRefs.has(refKey)) {
      seenEntryRefs.add(refKey);
      entries.push(entry);
    }
    if (attachment.kind === 'directory' && !seenRootRefs.has(refKey)) {
      seenRootRefs.add(refKey);
      conversationRoots.push({
        rootId: entry.id,
        kind: 'directory',
        label: entry.label,
        displayPath: attachment.path || resourceRef,
        absolutePath: attachment.absolutePath ?? (isAbsolutePath(resourceRef) ? resourceRef : undefined),
        source,
      });
    }
  };

  (input.attachments ?? []).forEach((attachment, index) => {
    addAttachment(
      attachment,
      index,
      attachment.scope === 'session' ? 'sessionAttachment' : 'currentAttachment',
      'Explicit user attachment for the current user turn.'
    );
  });

  recentAttachmentFacts(input.existingEvents ?? []).forEach((attachment, index) => {
    addAttachment(
      attachment,
      index,
      'recentAttachment',
      'Recent explicit user attachment selected from session projection.',
      false
    );
  });

  if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
    const workingDirectory = input.projectWorkingDirectory;
    const resourceRef = workingDirectory.absolutePath ?? workingDirectory.displayPath;
    const refKey = comparablePath(resourceRef);
    if (!seenRootRefs.has(refKey)) {
      seenRootRefs.add(refKey);
      conversationRoots.push({
        ...workingDirectory,
        rootId: workingDirectory.rootId || `project-root-${sanitizeId(workingDirectory.displayPath)}`,
        kind: 'directory',
        absolutePath: workingDirectory.absolutePath ?? (isAbsolutePath(resourceRef) ? resourceRef : undefined),
      });
    }
  }

  if (input.workspaceBinding?.openPath) {
    const resourceRef = input.workspaceBinding.openPath;
    const refKey = comparablePath(resourceRef);
    if (!seenRootRefs.has(refKey)) {
      seenRootRefs.add(refKey);
      conversationRoots.push({
        rootId: `editor-workspace-${sanitizeId(resourceRef)}`,
        kind: 'directory',
        label: `Editor workspace ${resourceRef}`,
        displayPath: resourceRef,
        absolutePath: resourceRef,
        source: 'workspaceBinding',
      });
    }
  }

  const workspaceScopeKey = [
    input.workspaceBinding?.workspaceId,
    input.workspaceBinding?.workspaceHash,
    input.workspaceBinding?.openPath,
    input.workspaceBinding?.activeFolderId,
  ].filter(Boolean).join(':') || `session:${input.sessionId}:${conversationRoots[0]?.rootId ?? 'no-root'}`;
  return {
    manifest: {
      id,
      workspaceScopeKey,
      workspaceId: input.workspaceBinding?.workspaceId,
      entries,
      budget: {
        maxEntries: Math.max(MAX_DERIVED_MANIFEST_ENTRIES, entries.length),
        maxBytes: RESOURCE_MANIFEST_MAX_BYTES,
      },
      defaultDenyPatterns: [],
    },
    conversationRoots,
  };
}

function manifestEntryId(
  attachment: AgentContextAttachment,
  index: number,
  source: ConversationResourceRoot['source']
): string {
  const base = (attachment.path || attachment.absolutePath || `attachment-${index}`)
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const prefix = source === 'recentAttachment' ? 'recent-attachment' : 'attachment';
  return `${prefix}-${index}-${base || 'resource'}`;
}

function recentAttachmentFacts(events: AgentEvent[]): AgentContextAttachment[] {
  const output: AgentContextAttachment[] = [];
  for (const event of [...events].reverse()) {
    if (output.length >= 16) break;
    if (event.kind !== 'user_msg') continue;
    const payload = objectRecord(event.payload);
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    for (const item of attachments) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const attachment = item as AgentContextAttachment;
      if (attachment.kind !== 'file' && attachment.kind !== 'directory') continue;
      if (!attachment.path && !attachment.absolutePath) continue;
      output.push(attachment);
      if (output.length >= 16) break;
    }
  }
  return output;
}

function buildSessionMemoryDocument(events: AgentEvent[]): string[] {
  const intentContext: string[] = [];
  const factContext: string[] = [];
  const decisionContext: string[] = [];

  for (const event of events.slice(-40)) {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;

    if (event.kind === 'user_msg') {
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      const attachments = Array.isArray(record.attachments)
        ? record.attachments
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
          .map((item) => `${String(item.kind ?? 'resource')}:${String(item.path ?? item.absolutePath ?? '')}`)
          .filter((item) => item.trim().length > 0)
        : [];
      if (content) intentContext.push(`User request: ${clip(content, 300)}${attachments.length ? ` attachments=${attachments.join(', ')}` : ''}`);
    }

    if (event.kind === 'requirement_confirmation') {
      const status = stringValue(record.status) ?? 'pending';
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      if (summary.trim()) intentContext.push(`Requirement draft (${status}): ${clip(summary.trim(), 300)}`);
    }

    if (event.kind === 'plan_card') {
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      if (summary.trim()) intentContext.push(`Plan intent: ${clip(summary.trim(), 320)}`);
      const actionBundle = objectRecord(record.actionBundle);
      const continuations = Array.isArray(actionBundle?.continuationExpectations)
        ? actionBundle.continuationExpectations
        : [];
      for (const continuation of continuations.slice(0, 4)) {
        const text = continuationSummary(continuation);
        if (text) intentContext.push(`Continuation intent: ${clip(text, 240)}`);
      }
    }

    if (event.kind === 'review_summary') {
      const status = stringValue(record.status) ?? 'unknown';
      const content = stringValue(record.content) ?? stringValue(record.summary) ?? '';
      if (content.trim()) {
        const target = status === 'waitingUserReview' ? intentContext : decisionContext;
        target.push(`Review ${status}: ${clip(content.trim(), 360)}`);
      }
      const facts = Array.isArray(record.facts) ? record.facts.filter((item): item is string => typeof item === 'string') : [];
      for (const fact of facts.slice(0, 8)) factContext.push(`Review fact: ${clip(fact, 260)}`);
      if (status === 'accepted' || status === 'needsRevision' || status === 'rejected') {
        decisionContext.push(`Review decision: ${status}${content.trim() ? ` guidance=${clip(content.trim(), 240)}` : ''}`);
      }
    }

    if (event.kind === 'requirement_decision' || event.kind === 'plan_review') {
      const status = stringValue(record.status) ?? stringValue(record.decision) ?? 'unknown';
      const summary = stringValue(record.summary) ?? stringValue(record.content) ?? '';
      decisionContext.push(`${event.kind}: ${status}${summary.trim() ? ` ${clip(summary.trim(), 240)}` : ''}`);
    }

    if (event.kind === 'assistant_msg') {
      const channel = typeof record.channel === 'string' ? record.channel : '';
      if (channel && channel !== 'final') continue;
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      if (content) intentContext.push(`Assistant final: ${clip(content, 260)}`);
    }

    if (event.kind === 'tool_result') {
      const toolName = stringValue(record.toolName) ?? 'tool';
      const summary = stringValue(record.summary) ?? '';
      if (summary.trim()) factContext.push(`Resource/tool fact ${toolName}: ${clip(summary.trim(), 260)}`);
      const output = objectRecord(record.output);
      if (output) {
        const items = Array.isArray(output.items) ? output.items : [];
        for (const item of items.slice(0, 6)) {
          const resource = objectRecord(item);
          const path = stringValue(resource?.path) ?? stringValue(resource?.absolutePath) ?? stringValue(resource?.manifestEntryId);
          const kind = stringValue(resource?.contentKind) ?? stringValue(resource?.resolvedKind) ?? 'resource';
          if (path) factContext.push(`ResourcePacket fact: ${kind} ${clip(path, 220)}`);
        }
      }
    }

    if (event.kind === 'workflow_stage') {
      const kernelEvent = objectRecord(record.kernelEvent);
      if (!kernelEvent) continue;
      const kind = stringValue(kernelEvent?.kind);
      if (kind === 'tool.completed') {
        const ok = kernelEvent?.ok === true;
        const output = objectRecord(kernelEvent.output);
        const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
        const validation = objectRecord(output?.validation);
        const validationKind = stringValue(validation?.kind);
        factContext.push(`ToolCompleted fact: ok=${ok}${path ? ` path=${clip(path, 220)}` : ''}${validationKind ? ` validation=${validationKind}` : ''}`);
      }
      if (kind === 'work_unit.completed' || kind === 'work_unit.failed' || kind === 'work_unit.blocked') {
        const workUnitId = stringValue(kernelEvent?.workUnitId);
        const output = objectRecord(kernelEvent?.output);
        const path = stringValue(output?.path) ?? stringValue(output?.absolutePath);
        factContext.push(`WorkUnit fact: ${kind}${workUnitId ? ` id=${clip(workUnitId, 160)}` : ''}${path ? ` path=${clip(path, 220)}` : ''}`);
      }
    }
  }

  const hints = [
    'Session short-term memory document:',
    'Boundary: intentContext is not evidence; factContext is the only generated-file evidence; decisionContext records user decisions and guidance.',
    intentContext.length
      ? `intentContext:\n${intentContext.slice(-10).map((item) => `- ${item}`).join('\n')}`
      : 'intentContext: none',
    factContext.length
      ? `factContext:\n${factContext.slice(-14).map((item) => `- ${item}`).join('\n')}`
      : 'factContext: none',
    decisionContext.length
      ? `decisionContext:\n${decisionContext.slice(-10).map((item) => `- ${item}`).join('\n')}`
      : 'decisionContext: none',
  ];
  return hints;
}

function buildImplementationBatchContext(events: AgentEvent[]): ImplementationBatchContext {
  const recentPlanSummaries: string[] = [];
  const continuationSummaries: string[] = [];
  let planCount = 0;
  for (const event of events.slice(-48)) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    planCount += 1;
    const summary = typeof payload.summary === 'string'
      ? payload.summary
      : typeof payload.content === 'string'
        ? payload.content
        : '';
    if (summary.trim()) recentPlanSummaries.push(clip(summary.trim(), 240));
    const actionBundle = objectRecord(payload.actionBundle);
    const continuations = Array.isArray(actionBundle?.continuationExpectations)
      ? actionBundle.continuationExpectations
      : [];
    for (const continuation of continuations) {
      const record = objectRecord(continuation);
      const title = typeof record?.title === 'string' ? record.title.trim() : '';
      const scope = Array.isArray(record?.resourceScope)
        ? record.resourceScope.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
        : '';
      const text = [title, scope ? `scope=${scope}` : ''].filter(Boolean).join(' ');
      if (text) continuationSummaries.push(clip(text, 240));
    }
  }
  return {
    batchIndex: planCount + 1,
    recentPlanSummaries: recentPlanSummaries.slice(-3),
    continuationSummaries: continuationSummaries.slice(-6),
  };
}

function implementationBatchHints(context: ImplementationBatchContext): string[] {
  const hints = [
    `Implementation batch context: nextBatchIndex=${context.batchIndex}. Generate only the next reviewable batch when proposing side-effect actions.`,
    'Context boundary: plan cards and continuation expectations are intent only; they are not evidence that files exist or were modified.',
    'Authoritative generated-file facts come only from ResourcePacket contents, ToolCompleted(ok=true), or WorkUnitCompleted facts.',
  ];
  if (context.recentPlanSummaries.length) {
    hints.push(`Recent implementation batch plans (intent only, not execution facts): ${context.recentPlanSummaries.join(' | ')}`);
  }
  if (context.continuationSummaries.length) {
    hints.push(`Pending continuation expectations (intent only, not files already created): ${context.continuationSummaries.join(' | ')}`);
  }
  return hints;
}

function manifestForResourceRequest(
  manifest: ResourceManifest,
  request: ResourceRequestDraft,
  roots: ConversationResourceRoot[]
): ResourceRequestResolution {
  const entries: ResourceManifestEntry[] = [];
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: string[] = [];

  const pushEntry = (entry: ResourceManifestEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  for (const item of request.items ?? []) {
    const exactId = item.manifestEntryId?.trim();
    if (exactId) {
      const exact = manifest.entries.find((entry) => entry.id === exactId);
      if (exact) {
        pushEntry(exact);
        continue;
      }
    }

    const pathCandidate = item.path?.trim() || item.manifestEntryId?.trim();
    if (!pathCandidate) {
      unresolved.push(item.id);
      continue;
    }

    const existing = findExistingEntryByPath(manifest, pathCandidate, roots);
    if (existing) {
      pushEntry(existing);
      continue;
    }

    const synthesized = synthesizeManifestEntryForPath(manifest, roots, item.id, pathCandidate, item.rootId, item.reason);
    if (synthesized.kind === 'entry') {
      manifest.entries.push(synthesized.entry);
      pushEntry(synthesized.entry);
      continue;
    }
    if (synthesized.kind === 'ambiguous') {
      ambiguous.push(`${pathCandidate} (${synthesized.reason})`);
      continue;
    }
    unresolved.push(`${pathCandidate} (${synthesized.reason})`);
  }

  return {
    manifest: {
      ...manifest,
      id: `${manifest.id}-request-${sanitizeId(request.id ?? 'resource-request')}`,
      entries,
    },
    unresolved,
    ambiguous,
    availableRoots: roots,
  };
}

type SynthesizedManifestEntryResult =
  | { kind: 'entry'; entry: ResourceManifestEntry }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unresolved'; reason: string };

function findExistingEntryByPath(
  manifest: ResourceManifest,
  requestedPath: string,
  roots: ConversationResourceRoot[]
): ResourceManifestEntry | undefined {
  const exact = manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(requestedPath));
  if (exact) return exact;
  const resolved = resolveRequestPath(requestedPath, undefined, roots);
  if (resolved.kind !== 'resolved') return undefined;
  const ref = joinFsPath(resolved.root.absolutePath ?? resolved.root.displayPath, resolved.relativePath);
  return manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(ref));
}

function synthesizeManifestEntryForPath(
  manifest: ResourceManifest,
  roots: ConversationResourceRoot[],
  itemId: string,
  requestedPath: string,
  rootId: string | undefined,
  reason: string
): SynthesizedManifestEntryResult {
  const resolved = resolveRequestPath(requestedPath, rootId, roots);
  if (resolved.kind !== 'resolved') return resolved;
  const resourceRef = joinFsPath(resolved.root.absolutePath ?? resolved.root.displayPath, resolved.relativePath);
  const existing = manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(resourceRef));
  if (existing) return { kind: 'entry', entry: existing };
  const entry: ResourceManifestEntry = {
    id: `path-${sanitizeId(resolved.root.rootId)}-${sanitizeId(resolved.relativePath || itemId)}`,
    kind: 'resource',
    label: `Resource ${resolved.root.displayPath}/${resolved.relativePath}`,
    resourceRef,
    readPolicy: 'autoRead',
    reason: reason || `Requested path under conversation root ${resolved.root.rootId}.`,
  };
  return { kind: 'entry', entry };
}

type ResolvedRequestPath =
  | { kind: 'resolved'; root: ConversationResourceRoot; relativePath: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unresolved'; reason: string };

function resolveRequestPath(
  requestedPath: string,
  rootId: string | undefined,
  roots: ConversationResourceRoot[]
): ResolvedRequestPath {
  const trimmed = requestedPath.trim();
  if (!trimmed) return { kind: 'unresolved', reason: 'empty path' };
  if (!roots.length) return { kind: 'unresolved', reason: 'no available conversation root' };

  if (rootId) {
    const root = roots.find((item) => item.rootId === rootId);
    if (!root) return { kind: 'unresolved', reason: `unknown rootId ${rootId}` };
    const relativePath = relativePathForRoot(trimmed, root, true);
    if (!relativePath) return { kind: 'unresolved', reason: `path is outside root ${rootId}` };
    return { kind: 'resolved', root, relativePath };
  }

  if (isAbsolutePath(trimmed)) {
    const matches = roots
      .map((root) => ({ root, relativePath: relativePathForRoot(trimmed, root, true) }))
      .filter((item): item is { root: ConversationResourceRoot; relativePath: string } => Boolean(item.relativePath))
      .sort((left, right) => comparablePath(right.root.absolutePath ?? right.root.displayPath).length - comparablePath(left.root.absolutePath ?? left.root.displayPath).length);
    if (matches.length === 0) return { kind: 'unresolved', reason: 'absolute path is outside explicit attachments and project roots' };
    return { kind: 'resolved', root: matches[0].root, relativePath: matches[0].relativePath };
  }

  const explicitMatches = roots
    .map((root) => ({ root, relativePath: relativePathForRoot(trimmed, root, false) }))
    .filter((item): item is { root: ConversationResourceRoot; relativePath: string } => Boolean(item.relativePath));
  if (explicitMatches.length > 0) {
    explicitMatches.sort((left, right) => right.root.displayPath.length - left.root.displayPath.length);
    return { kind: 'resolved', root: explicitMatches[0].root, relativePath: explicitMatches[0].relativePath };
  }

  const relativePath = normalizeRelativePath(trimmed);
  if (!relativePath) return { kind: 'unresolved', reason: 'path traversal or empty relative path is not allowed' };
  const sorted = [...roots].sort((left, right) => rootPriority(left) - rootPriority(right));
  const bestPriority = rootPriority(sorted[0]);
  const candidates = sorted.filter((root) => rootPriority(root) === bestPriority);
  if (candidates.length === 1) {
    return { kind: 'resolved', root: candidates[0], relativePath };
  }
  return {
    kind: 'ambiguous',
    reason: `multiple roots at the same priority: ${candidates.map((root) => root.rootId).join(', ')}`,
  };
}

function relativePathForRoot(
  requestedPath: string,
  root: ConversationResourceRoot,
  allowPlainRelative: boolean
): string | undefined {
  const normalized = normalizeSlashes(requestedPath);
  const rootKeys = [
    root.rootId,
    root.displayPath,
    root.absolutePath,
    basename(root.displayPath),
    root.absolutePath ? basename(root.absolutePath) : undefined,
  ].filter((item): item is string => Boolean(item && item.trim()));

  for (const key of rootKeys) {
    const normalizedKey = normalizeSlashes(key).replace(/\/+$/g, '');
    if (!normalizedKey) continue;
    if (normalized === normalizedKey) return '.';
    if (normalized.startsWith(`${normalizedKey}/`)) {
      return normalizeRelativePath(normalized.slice(normalizedKey.length + 1));
    }
  }

  if (isAbsolutePath(normalized)) {
    const rootPath = root.absolutePath ? normalizeSlashes(root.absolutePath).replace(/\/+$/g, '') : undefined;
    if (!rootPath) return undefined;
    if (normalized === rootPath) return '.';
    if (!normalized.startsWith(`${rootPath}/`)) return undefined;
    return normalizeRelativePath(normalized.slice(rootPath.length + 1));
  }

  return allowPlainRelative ? normalizeRelativePath(normalized) : undefined;
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeSlashes(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.join('/') || '.';
}

function normalizeSlashes(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function comparablePath(value: string): string {
  return normalizeSlashes(value).replace(/\/+$/g, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function basename(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/g, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function rootPriority(root: ConversationResourceRoot): number {
  if (root.source === 'currentAttachment') return 0;
  if (root.source === 'sessionAttachment') return 1;
  if (root.source === 'projectWorkingDirectory') return 2;
  if (root.source === 'recentAttachment') return 3;
  return 4;
}

function resourceResolutionDiagnostic(resolution: ResourceRequestResolution): string {
  const details = [
    resolution.unresolved.length ? `无法定位：${resolution.unresolved.join('; ')}` : '',
    resolution.ambiguous.length ? `存在多个候选根目录：${resolution.ambiguous.join('; ')}` : '',
  ].filter(Boolean).join('\n');
  const roots = resolution.availableRoots.length
    ? resolution.availableRoots.map((root) => `${root.rootId} -> ${root.displayPath}`).join('\n')
    : '无可用附件或项目目录。';
  return [
    '模型请求的资源无法在当前附件或项目目录中定位，Session 已拒绝该请求。',
    details,
    '可用项目/附件根目录：',
    roots,
    '请重新指定明确附件、rootId 或相对路径。',
  ].filter(Boolean).join('\n');
}

function addDiscoveredManifestEntries(manifest: ResourceManifest, packet: ResourcePacket): void {
  const existing = new Set(manifest.entries.map((entry) => entry.id));
  for (const item of packet.items) {
    if (manifest.entries.length >= MAX_DERIVED_MANIFEST_ENTRIES) return;
    if (item.contentKind !== 'directoryTree') continue;
    const raw = item as ResourcePacketItem & { nodes?: unknown; absolutePath?: string; path?: string };
    const root = typeof raw.absolutePath === 'string' ? raw.absolutePath : undefined;
    if (!root || !Array.isArray(raw.nodes)) continue;
    for (const node of flattenNodes(raw.nodes)) {
      if (manifest.entries.length >= MAX_DERIVED_MANIFEST_ENTRIES) return;
      const nodePath = typeof node.path === 'string' ? node.path : '';
      const nodeType = node.type === 'directory' ? 'directory' : node.type === 'file' ? 'file' : undefined;
      if (!nodePath || !nodeType) continue;
      const id = `${item.manifestEntryId}:${sanitizeId(nodePath)}`;
      if (existing.has(id)) continue;
      existing.add(id);
      manifest.entries.push({
        id,
        kind: nodeType,
        label: `${nodeType === 'directory' ? 'Directory' : 'File'} ${nodePath}`,
        resourceRef: joinFsPath(root, nodePath),
        readPolicy: 'autoRead',
        reason: `Discovered inside explicit directory attachment ${item.manifestEntryId}.`,
      });
    }
  }
}

function flattenNodes(nodes: unknown[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const stack = nodes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  while (stack.length) {
    const node = stack.shift()!;
    output.push(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child && typeof child === 'object' && !Array.isArray(child)) stack.push(child as Record<string, unknown>);
      }
    }
  }
  return output;
}

function findStateContract(events: unknown[]): KernelStateContractRef | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const contract = objectRecord(record?.stateContract);
    if (contract) return contract as unknown as KernelStateContractRef;
  }
  return undefined;
}

function findDriverRequest(events: unknown[]): DriverRequestRef | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const driverRequest = objectRecord(record?.driverRequest);
    if (driverRequest) return driverRequest as unknown as DriverRequestRef;
  }
  return undefined;
}

function firstString(events: unknown[], key: string): string | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function findResourcePacket(events: unknown[]): ResourcePacket | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const packet = objectRecord(record?.packet);
    if (!packet) continue;
    const items = Array.isArray(packet.items) ? packet.items : [];
    return {
      id: typeof packet.id === 'string' ? packet.id : 'resource-packet',
      workspaceScopeKey: typeof packet.workspaceScopeKey === 'string' ? packet.workspaceScopeKey : 'workspace',
      requestId: typeof packet.requestId === 'string' ? packet.requestId : 'resource-request',
      items: items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map(resourcePacketItemFromKernel),
    };
  }
  return undefined;
}

function resourcePacketItemFromKernel(item: Record<string, unknown>): ResourcePacketItem {
  const status = item.status === 'resolved' || item.status === 'provided'
    ? item.status
    : item.status === 'denied'
      ? 'denied'
      : item.status === 'needsUserApproval'
        ? 'needsUserApproval'
        : 'error';
  const nodes = Array.isArray(item.nodes) ? item.nodes : undefined;
  const content = typeof item.content === 'string'
    ? item.content
    : nodes
      ? JSON.stringify(nodes, null, 2)
      : undefined;
  return {
    ...(item as unknown as Record<string, unknown>),
    requestItemId: typeof item.requestItemId === 'string' ? item.requestItemId : 'item',
    manifestEntryId: typeof item.manifestEntryId === 'string' ? item.manifestEntryId : 'entry',
    readPolicy: 'autoRead',
    status,
    contentKind: typeof item.contentKind === 'string' ? item.contentKind as ResourcePacketItem['contentKind'] : undefined,
    contentSummary: typeof item.contentSummary === 'string' ? item.contentSummary : typeof item.message === 'string' ? item.message : undefined,
    promptContent: content,
    truncated: Boolean(item.truncated),
    originalBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : undefined,
    denialReason: typeof item.reason === 'string' ? item.reason : typeof item.message === 'string' ? item.message : undefined,
    evidenceRefs: Array.isArray(item.evidenceRefs)
      ? item.evidenceRefs.filter((value): value is string => typeof value === 'string')
      : [],
    sourceKind: 'kernelResource',
  };
}

function projectKernelEvent(sessionId: string, event: unknown, ts: string, id: string): AgentEvent {
  const record = objectRecord(event) ?? {};
  const kind = typeof record.kind === 'string' ? record.kind : 'kernel.event';
  if (kind === 'proposal.reviewed') {
    const report = objectRecord(record.report) ?? {};
    const status = typeof report.status === 'string' ? report.status : 'awaitingUserApproval';
    const planId = typeof report.planId === 'string' ? report.planId : 'agent-plan';
    const summary = typeof report.kernelGeneratedPermissionSummary === 'string' && report.kernelGeneratedPermissionSummary.trim()
      ? report.kernelGeneratedPermissionSummary
      : 'Kernel PlanReview 已完成，请确认是否同意计划。';
    return {
      id,
      sessionId,
      ts,
      kind: 'plan_review',
      payload: {
        title: '计划确认',
        summary,
        status,
        runId: typeof record.runId === 'string' ? record.runId : undefined,
        planId,
        confirmable: status === 'awaitingUserApproval' || status === 'awaitingTemporaryGrant',
        facts: planReviewFacts(report),
        channel: 'action',
        visibility: 'conversation',
        presentation: 'body',
        report,
        kernelEvent: record,
      },
    };
  }
  if (kind === 'proposal.rejected' || kind === 'work_unit.failed') {
    return {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: typeof record.reason === 'string' ? record.reason : 'Kernel rejected the proposal.',
        channel: 'error',
        visibility: 'conversation',
        kernelEvent: record,
      },
    };
  }
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: kind,
      status: kind.endsWith('produced') || kind.endsWith('accepted') ? 'completed' : 'running',
      summary: kernelEventSummary(kind, record),
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      kernelEvent: record,
    },
  };
}

function kernelEventSummary(kind: string, record: Record<string, unknown>): string {
  if (kind === 'driver.request_produced') return 'Session DriverRequest produced by Kernel.';
  if (kind === 'state.entered') return 'Kernel state contract entered.';
  if (kind === 'resource.packet_produced') return 'Kernel ResourcePacket produced.';
  if (kind === 'proposal.accepted') return 'Kernel accepted proposal envelope.';
  return typeof record.summary === 'string' ? record.summary : kind;
}

function resourcePacketEvent(sessionId: string, packet: ResourcePacket, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'tool_result',
    payload: {
      toolName: 'kernel.resourceResolve',
      status: packet.items.some((item) => item.status === 'error' || item.status === 'denied') ? 'error' : 'ok',
      summary: `Kernel resolved ${packet.items.length} resource item(s).`,
      output: packet,
      channel: 'tool',
      visibility: 'conversation',
      presentation: 'collapsible',
    },
  };
}

function answerEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent {
  const payload = objectRecord(proposal.payload) ?? {};
  const answer = objectRecord(payload.answer) ?? payload;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content: typeof answer.content === 'string' ? answer.content : '',
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
    },
  };
}

function finalDiagnosticEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      diagnostic: true,
    },
  };
}

function thinkingEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'reasoning',
      visibility: 'conversation',
      presentation: 'collapsible',
      label: 'Thinking',
    },
  };
}

function reasoningEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'reasoning',
      visibility: 'conversation',
      presentation: 'collapsible',
      label: 'Thinking',
    },
  };
}

function readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  return actionBundle as unknown as ActionBundleDraft | undefined;
}

function parseAndValidateProposal(input: {
  raw: string | Record<string, unknown>;
  runId: string;
  sessionId?: string;
  source?: 'llm' | 'user' | 'system' | 'cache';
}): ProposalEnvelope {
  const proposal = parseProposalEnvelope(input);
  validateProposalSemantics(proposal);
  return proposal;
}

function validateProposalSemantics(proposal: ProposalEnvelope): void {
  if (proposal.kind !== 'actionBundle') return;
  const payload = objectRecord(proposal.payload) ?? {};
  const bundle = readActionBundle(proposal);
  if (!bundle) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle must include an actionBundle object.');
  }
  if (typeof bundle.id !== 'string' || !bundle.id.trim()) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.id must be a non-empty string.');
  }
  if (bundle.version !== '1') {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.version must be "1".');
  }
  if (typeof bundle.goal !== 'string' || !bundle.goal.trim()) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.goal must be a non-empty string.');
  }
  if (!Array.isArray(bundle.actions) || bundle.actions.length === 0) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.actions must not be empty.');
  }
  if (bundle.actions.length > MAX_ACTION_BUNDLE_ACTIONS) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `ActionBundle has ${bundle.actions.length} actions; output only the next implementation batch with at most ${MAX_ACTION_BUNDLE_ACTIONS} actions.`
    );
  }
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  if (codeBlocks.length > MAX_ACTION_BUNDLE_CODE_BLOCKS) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `ActionBundle has ${codeBlocks.length} codeBlocks; output only the next implementation batch with at most ${MAX_ACTION_BUNDLE_CODE_BLOCKS} codeBlocks.`
    );
  }
  const codeBlockIds = new Set<string>();
  let totalCodeBytes = 0;
  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    const blockId = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!blockId) {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].id must be a non-empty string.`);
    }
    codeBlockIds.add(blockId);
    const content = typeof record?.content === 'string' ? record.content : '';
    const size = utf8Bytes(content);
    totalCodeBytes += size;
    if (size > MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES) {
      throw new AgentPlanParseError(
        'action_bundle_budget_exceeded',
        `codeBlocks[${index}] is ${size} bytes; split implementation output so each codeBlock is at most ${MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES} bytes.`
      );
    }
  }
  if (totalCodeBytes > MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `codeBlocks total content is ${totalCodeBytes} bytes; output only the next implementation batch with at most ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} bytes of code.`
    );
  }
  for (const [index, action] of bundle.actions.entries()) {
    if (typeof action.id !== 'string' || !action.id.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].id must be a non-empty string.`);
    }
    if (typeof action.title !== 'string' || !action.title.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].title must be a non-empty string.`);
    }
    if (typeof action.capability !== 'string' || !action.capability.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].capability must be a non-empty string.`);
    }
    if (!Array.isArray(action.resourceScope)) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].resourceScope must be an array.`);
    }
    if ((action.capability === 'workspace.write' || action.capability === 'workspace.create') && !action.sourceBlockId?.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${action.capability} must include sourceBlockId.`);
    }
    if (action.sourceBlockId && !codeBlockIds.has(action.sourceBlockId)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `actionBundle.actions[${index}].sourceBlockId "${action.sourceBlockId}" does not match any codeBlocks[].id.`
      );
    }
  }
  const sideEffectful = bundle.actions.some((action) => SIDE_EFFECT_CAPABILITIES.has(action.capability));
  if (!sideEffectful) return;
  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    const hasPath = typeof record?.path === 'string' && record.path.trim();
    const hasTargetPath = typeof record?.targetPath === 'string' && record.targetPath.trim();
    if (!hasPath && !hasTargetPath) {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}] must include path or targetPath.`);
    }
    if (typeof record?.content !== 'string') {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].content must be a string.`);
    }
  }
  const userPlan = typeof payload.userPlan === 'string' ? payload.userPlan.trim() : '';
  validateDetailedUserPlan(userPlan);
  const validationExpectations = Array.isArray(bundle.validationExpectations) ? bundle.validationExpectations : [];
  const reviewExpectations = Array.isArray(bundle.reviewExpectations) ? bundle.reviewExpectations : [];
  if (!validationExpectations.some((item) => item?.description?.trim())) {
    throw new AgentPlanParseError(
      'action_bundle_evidence_required',
      'Side-effect actionBundle must include non-empty validationExpectations describing reviewable evidence.'
    );
  }
  if (!reviewExpectations.some((item) => item?.description?.trim())) {
    throw new AgentPlanParseError(
      'action_bundle_review_required',
      'Side-effect actionBundle must include non-empty reviewExpectations describing user review obligations.'
    );
  }
}

function validateDetailedUserPlan(userPlan: string): void {
  if (userPlan.length < 240) {
    throw new AgentPlanParseError(
      'action_bundle_plan_required',
      'Side-effect actionBundle must include a detailed Markdown userPlan, not a one-line summary.'
    );
  }
  const missing = ['Summary', 'Key Changes', 'Interfaces', 'Test Plan', 'Assumptions']
    .filter((heading) => !new RegExp(`(^|\\n)#{1,3}\\s+${escapeRegExp(heading)}\\b`, 'i').test(userPlan));
  if (missing.length > 0) {
    throw new AgentPlanParseError(
      'action_bundle_plan_required',
      `Side-effect actionBundle.userPlan is missing required Markdown section(s): ${missing.join(', ')}.`
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actionBundlePlanCardEvent(
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  report: Record<string, unknown> | undefined,
  ts: string,
  id: string
): AgentEvent {
  const payload = objectRecord(proposal.payload) ?? {};
  const actionBundle = readActionBundle(proposal);
  const userPlan = typeof payload.userPlan === 'string' && payload.userPlan.trim()
    ? payload.userPlan
    : actionBundle?.goal ?? 'Agent plan';
  return {
    id,
    sessionId: state.sessionId,
    ts,
    kind: 'plan_card',
    payload: {
      title: 'Plan',
      summary: userPlan,
      content: userPlan,
      runId: proposal.runId,
      planId: actionBundle?.id ?? proposal.proposalId,
      proposalId: proposal.proposalId,
      implementationBatch: state.implementationBatch,
      actionBundle,
      codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
      commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
      expectedValidation: typeof payload.expectedValidation === 'string' ? payload.expectedValidation : '',
      reviewGuide: typeof payload.reviewGuide === 'string' ? payload.reviewGuide : '',
      planReviewReport: report,
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function findPlanReviewReport(events: unknown[]): Record<string, unknown> | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    if (record?.kind !== 'proposal.reviewed') continue;
    const report = objectRecord(record.report);
    if (report) return report;
  }
  return undefined;
}

function planReviewNeedsRepair(report: Record<string, unknown>): boolean {
  if (
    report.status === 'denied' &&
    planReviewDiagnosticSummary(report).includes('actionBundle payload failed Kernel schema validation')
  ) {
    return true;
  }
  if (report.status !== 'needsRevision') return false;
  const repairableCodes = new Set(['completion_evidence_required']);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return findings.some((finding) => {
    const record = objectRecord(finding);
    return typeof record?.code === 'string' && repairableCodes.has(record.code);
  });
}

function planReviewDenied(report: Record<string, unknown>): boolean {
  return report.status === 'denied' || report.status === 'interfaceOnly';
}

function planReviewDiagnosticSummary(report: Record<string, unknown>): string {
  const denied = Array.isArray(report.deniedReasons)
    ? report.deniedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const blocked = Array.isArray(report.blockedReasons)
    ? report.blockedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
  return [...denied, ...blocked, summary].filter(Boolean).join('；') || '计划审查未通过。';
}

function shouldAttemptActionBundleCompactionRepair(state: SessionDriverLoopRunState): boolean {
  const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
  if (allowed.length && !allowed.includes('actionBundle')) return false;
  const capabilities = state.stateContract?.capabilityProjection ?? state.driverRequest?.stateContract?.capabilityProjection ?? [];
  return capabilities.some((capability) => SIDE_EFFECT_CAPABILITIES.has(capability));
}

function planReviewFacts(report: Record<string, unknown> | undefined): string[] {
  if (!report) return [];
  const facts: string[] = [];
  const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
  if (summary) facts.push(summary);
  for (const key of ['blockedReasons', 'deniedReasons', 'permissionGaps', 'hardFloorHits'] as const) {
    const values = Array.isArray(report[key]) ? report[key] : [];
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) facts.push(`${key}: ${value}`);
    }
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  for (const finding of findings) {
    const record = objectRecord(finding);
    const code = typeof record?.code === 'string' ? record.code : '';
    const message = typeof record?.message === 'string' ? record.message : '';
    if (code || message) facts.push(`finding: ${[code, message].filter(Boolean).join(' - ')}`);
  }
  return facts;
}

interface SessionPlanContext {
  sessionId: string;
  runId: string;
  planId: string;
  proposalId?: string;
  userPlan: string;
  actionBundle: Record<string, unknown>;
  codeBlocks: unknown[];
  commandBlocks: unknown[];
  expectedValidation: string;
  reviewGuide: string;
  planReviewReport?: Record<string, unknown>;
}

interface SessionReviewContext {
  sessionId: string;
  runId: string;
  reviewId: string;
  sourcePlanId?: string;
  summary: string;
  content: string;
  userPlan: string;
  continuations: unknown[];
  reviewExpectations: unknown[];
  expectedValidation: string;
  reviewGuide: string;
  facts: string[];
}

function findPlanCard(events: AgentEvent[], runId?: string, planId?: string): SessionPlanContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    const candidate = payload ? planContextFromEvent(event, payload) : null;
    if (!candidate) continue;
    if (runId && candidate.runId !== runId) continue;
    if (planId && !planAliases(candidate).has(planId)) continue;
    return candidate;
  }
  return null;
}

function latestExecutablePlan(events: AgentEvent[], previousRunId?: string): SessionPlanContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    const candidate = payload ? planContextFromEvent(event, payload) : null;
    if (!candidate) continue;
    if (previousRunId && candidate.runId === previousRunId) continue;
    if (planAlreadyResolved(events, candidate)) continue;
    return candidate;
  }
  return null;
}

function planContextFromEvent(event: AgentEvent, payload: Record<string, unknown>): SessionPlanContext | null {
  const actionBundle = objectRecord(payload.actionBundle);
  if (!actionBundle) return null;
  const planId = stringValue(payload.planId)
    ?? stringValue(actionBundle.id)
    ?? stringValue(payload.proposalId);
  const runId = stringValue(payload.runId);
  if (!planId || !runId) return null;
  return {
    sessionId: event.sessionId,
    runId,
    planId,
    proposalId: stringValue(payload.proposalId),
    userPlan: stringValue(payload.content) ?? stringValue(payload.summary) ?? 'Agent plan',
    actionBundle,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
    expectedValidation: stringValue(payload.expectedValidation) ?? '',
    reviewGuide: stringValue(payload.reviewGuide) ?? '',
    planReviewReport: objectRecord(payload.planReviewReport) ?? undefined,
  };
}

function planAliases(plan: SessionPlanContext): Set<string> {
  const aliases = new Set<string>([plan.planId]);
  if (plan.proposalId) aliases.add(plan.proposalId);
  const bundleId = stringValue(plan.actionBundle.id);
  if (bundleId) aliases.add(bundleId);
  const reportPlanId = stringValue(plan.planReviewReport?.planId);
  if (reportPlanId) aliases.add(reportPlanId);
  return aliases;
}

function planAlreadyResolved(events: AgentEvent[], plan: SessionPlanContext): boolean {
  const aliases = planAliases(plan);
  return events.some((event) => {
    if (event.kind !== 'plan_review') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    const runId = stringValue(payload.runId);
    const planId = stringValue(payload.planId);
    return runId === plan.runId && (!planId || aliases.has(planId));
  });
}

function planAutoExecutableAfterRequirement(plan: SessionPlanContext): boolean {
  const report = plan.planReviewReport;
  const status = stringValue(report?.status);
  if (status === 'denied' || status === 'needsRevision' || status === 'interfaceOnly') return false;
  const hardFloorHits = Array.isArray(report?.hardFloorHits) ? report?.hardFloorHits : [];
  const deniedReasons = Array.isArray(report?.deniedReasons) ? report?.deniedReasons : [];
  const blockedReasons = Array.isArray(report?.blockedReasons) ? report?.blockedReasons : [];
  return hardFloorHits.length === 0 && deniedReasons.length === 0 && blockedReasons.length === 0;
}

function planReviewDecisionEvent(
  sessionId: string,
  plan: SessionPlanContext,
  status: 'accepted' | 'rejected' | 'needsRevision',
  summary: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'plan_review',
    payload: {
      title: '计划确认',
      summary: summary || (status === 'accepted' ? '用户已确认计划，准备进入执行。' : '用户要求修改计划。'),
      status,
      runId: plan.runId,
      planId: plan.planId,
      confirmable: false,
      facts: planReviewFacts(plan.planReviewReport),
      channel: status === 'accepted' ? 'progress' : 'final',
      visibility: 'conversation',
      presentation: 'body',
      report: plan.planReviewReport,
    },
  };
}

function temporaryGrantsForPlan(plan: SessionPlanContext): Record<string, unknown>[] {
  const report = plan.planReviewReport ?? {};
  const gaps = Array.isArray(report.permissionGaps)
    ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const actions = Array.isArray(plan.actionBundle.actions)
    ? plan.actionBundle.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const grants: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const capability of gaps) {
    const scopes = resourceScopesForCapability(actions, capability);
    if (!scopes.length) {
      const key = `${capability}:*`;
      if (!seen.has(key)) {
        seen.add(key);
        grants.push(temporaryGrant(plan, capability));
      }
      continue;
    }
    for (const scope of scopes) {
      const key = `${capability}:${scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(temporaryGrant(plan, capability, scope));
    }
  }
  return grants;
}

function resourceScopesForCapability(actions: Record<string, unknown>[], capability: string): string[] {
  return actions
    .filter((action) => stringValue(action.capability) === capability)
    .flatMap((action) => Array.isArray(action.resourceScope) ? action.resourceScope : [])
    .filter((scope): scope is string => typeof scope === 'string' && scope.trim().length > 0)
    .filter((scope) => scope !== 'workspace' && !scope.includes('*') && !scope.startsWith('search:') && !scope.startsWith('symbol:'));
}

function temporaryGrant(plan: SessionPlanContext, capability: string, resourcePath?: string): Record<string, unknown> {
  return {
    id: `grant-${safeSegment(plan.planId)}-${safeSegment(capability)}-${resourcePath ? safeSegment(resourcePath) : 'run'}`,
    capability,
    resourceKind: resourceKindForCapability(capability),
    resourcePath,
    reason: `Plan ${plan.planId} accepted by user through Session DecisionResolver`,
  };
}

function resourceKindForCapability(capability: string): string {
  if (['workspace.write', 'workspace.delete', 'workspace.rename', 'workspace.create'].includes(capability)) return 'workspaceFile';
  if (capability === 'git.write') return 'git';
  if (capability === 'process.exec') return 'process';
  if (capability === 'network.egress') return 'network';
  if (capability === 'browser.control') return 'browser';
  if (capability === 'secret.read') return 'secret';
  return 'capability';
}

function reviewSummaryEvent(
  sessionId: string,
  plan: SessionPlanContext,
  kernelEvents: unknown[],
  ts: string,
  id: string
): AgentEvent {
  const facts = reviewFactLines(kernelEvents);
  const reviewFacts = findReviewFacts(kernelEvents);
  const completed = reviewFacts
    ? arrayLength(reviewFacts.completedWorkUnits)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.completed').length;
  const failed = reviewFacts
    ? arrayLength(reviewFacts.failedWorkUnits)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.failed').length;
  const blocked = reviewFacts
    ? arrayLength(reviewFacts.blockedWorkUnits)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.blocked').length;
  const toolResults = reviewFacts
    ? arrayLength(reviewFacts.toolResults)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'tool.completed').length;
  const continuations = Array.isArray(plan.actionBundle.continuationExpectations) ? plan.actionBundle.continuationExpectations : [];
  const summary = failed || blocked
    ? '当前批次已推进，但存在失败或阻塞项，请审查 Kernel facts 后决定是否修订。'
    : '当前批次已执行，请审查 Kernel tool facts 与验证结果。';
  return {
    id,
    sessionId,
    ts,
    kind: 'review_summary',
    payload: {
      title: 'Review',
      summary,
      content: waitingReviewContent(plan, facts, summary, completed, failed, blocked, toolResults, continuations),
      status: 'waitingUserReview',
      runId: plan.runId,
      reviewId: `${plan.runId}:${plan.planId}`,
      sourcePlanId: plan.planId,
      confirmable: true,
      continuationRequested: false,
      continuationCount: continuations.length,
      continuations,
      reviewExpectations: Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [],
      reviewFacts,
      facts,
      factCounts: {
        workUnitsCompleted: completed,
        workUnitsFailed: failed,
        workUnitsBlocked: blocked,
        toolResults,
      },
      channel: 'review',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function waitingReviewContent(
  plan: SessionPlanContext,
  facts: string[],
  summary: string,
  completed: number,
  failed: number,
  blocked: number,
  toolResults: number,
  continuations: unknown[]
): string {
  const reviewLines = reviewExpectationLines(plan);
  return [
    '## Review',
    '',
    summary,
    '',
    '### 执行结果',
    `- WorkUnit 完成：${completed}`,
    `- WorkUnit 失败：${failed}`,
    `- WorkUnit 阻塞：${blocked}`,
    `- Tool facts：${toolResults}`,
    '',
    '### Kernel facts',
    facts.length ? facts.join('\n') : '- 当前批次没有可展示的 Kernel facts。',
    '',
    '### 原计划摘要',
    clip(plan.userPlan, 1200),
    '',
    '### 验证与启动建议',
    reviewLines.length ? reviewLines.join('\n') : '- 当前计划未提供可执行验证命令，需要下一轮补充。',
    '',
    '### 后续决策',
    failed || blocked
      ? '- 空输入通过并结束当前批次，不会自动执行失败项；如需修复，请在输入框输入 Review 修改意见，系统会重新进入 Plan。'
      : '- 空输入通过并结束当前批次；输入文字会作为 Review 修订意见，系统会重新进入 Plan。',
    continuations.length
      ? `- 当前计划登记了 ${continuations.length} 个后续意图；Review 通过只记录这些意图，不会自动生成或执行下一批。需要继续时，请在输入框明确描述下一步。`
      : '- 当前计划没有登记后续批次。',
  ].join('\n');
}

function reviewFactLines(kernelEvents: unknown[]): string[] {
  const facts = findReviewFacts(kernelEvents);
  if (facts) {
    const lines: string[] = [];
    const completed = Array.isArray(facts.completedWorkUnits) ? facts.completedWorkUnits : [];
    const failed = Array.isArray(facts.failedWorkUnits) ? facts.failedWorkUnits : [];
    const blocked = Array.isArray(facts.blockedWorkUnits) ? facts.blockedWorkUnits : [];
    const tools = Array.isArray(facts.toolResults) ? facts.toolResults : [];
    for (const item of completed) {
      const record = objectRecord(item);
      lines.push(`- \`${stringValue(record?.workUnitId) ?? 'work-unit'}\` completed${record?.output ? `：${clipJson(record.output, 180)}` : ''}`);
    }
    for (const item of failed) {
      const record = objectRecord(item);
      const error = objectRecord(record?.error);
      lines.push(`- \`${stringValue(record?.workUnitId) ?? 'work-unit'}\` failed：${stringValue(error?.message) ?? 'unknown error'}`);
    }
    for (const item of blocked) {
      const record = objectRecord(item);
      lines.push(`- \`${stringValue(record?.workUnitId) ?? 'work-unit'}\` blocked：${stringValue(record?.reason) ?? 'blocked'}`);
    }
    for (const item of tools) {
      const record = objectRecord(item);
      const error = objectRecord(record?.error);
      const status = record?.ok === true ? 'ok' : 'error';
      const detail = stringValue(error?.message) ?? (record?.output ? clipJson(record.output, 180) : 'no output');
      lines.push(`- \`${stringValue(record?.toolName) ?? 'tool'}\` ${status}：${detail}`);
    }
    return lines;
  }
  return kernelEvents.flatMap((event) => {
    const record = objectRecord(event);
    if (!record) return [];
    const kind = stringValue(record.kind);
    if (kind === 'work_unit.completed') {
      return [`- \`${stringValue(record.workUnitId) ?? 'work-unit'}\` completed${record.output ? `：${clipJson(record.output, 180)}` : ''}`];
    }
    if (kind === 'work_unit.failed') {
      const error = objectRecord(record.error);
      return [`- \`${stringValue(record.workUnitId) ?? 'work-unit'}\` failed：${stringValue(error?.message) ?? 'unknown error'}`];
    }
    if (kind === 'work_unit.blocked') {
      return [`- \`${stringValue(record.workUnitId) ?? 'work-unit'}\` blocked：${stringValue(record.reason) ?? 'blocked'}`];
    }
    if (kind === 'tool.completed') {
      const error = objectRecord(record.error);
      const status = record.ok === true ? 'ok' : 'error';
      const detail = stringValue(error?.message) ?? (record.output ? clipJson(record.output, 180) : 'no output');
      return [`- \`${stringValue(record.toolName) ?? 'tool'}\` ${status}：${detail}`];
    }
    return [];
  });
}

function findReviewFacts(kernelEvents: unknown[]): Record<string, unknown> | undefined {
  for (const event of [...kernelEvents].reverse()) {
    const record = objectRecord(event);
    if (record?.kind !== 'review.facts_produced') continue;
    return objectRecord(record.facts) ?? undefined;
  }
  return undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function reviewExpectationLines(plan: SessionPlanContext): string[] {
  const lines: string[] = [];
  if (plan.expectedValidation.trim()) lines.push(`- 验证要求：${plan.expectedValidation.trim()}`);
  if (plan.reviewGuide.trim()) lines.push(`- Review 指引：${plan.reviewGuide.trim()}`);
  const expectations = Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [];
  for (const item of expectations) {
    const record = objectRecord(item);
    const text = stringValue(record?.description) ?? stringValue(record?.summary) ?? stringValue(record?.command);
    if (text?.trim()) lines.push(`- ${text.trim()}`);
  }
  return lines;
}

function findWaitingReview(events: AgentEvent[], runId?: string): SessionReviewContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'review_summary') continue;
    const payload = objectRecord(event.payload);
    if (!payload || stringValue(payload.status) !== 'waitingUserReview') continue;
    const candidateRunId = stringValue(payload.runId);
    if (!candidateRunId || (runId && candidateRunId !== runId)) continue;
    return {
      sessionId: event.sessionId,
      runId: candidateRunId,
      reviewId: stringValue(payload.reviewId) ?? candidateRunId,
      sourcePlanId: stringValue(payload.sourcePlanId),
      summary: stringValue(payload.summary) ?? '',
      content: stringValue(payload.content) ?? '',
      userPlan: stringValue(payload.userPlan) ?? '',
      continuations: Array.isArray(payload.continuations) ? payload.continuations : [],
      reviewExpectations: Array.isArray(payload.reviewExpectations) ? payload.reviewExpectations : [],
      expectedValidation: stringValue(payload.expectedValidation) ?? '',
      reviewGuide: stringValue(payload.reviewGuide) ?? '',
      facts: Array.isArray(payload.facts) ? payload.facts.filter((item): item is string => typeof item === 'string') : [],
    };
  }
  return null;
}

function reviewAlreadyResolved(events: AgentEvent[], review: SessionReviewContext): boolean {
  return events.some((event) => {
    if (event.kind !== 'review_summary') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    return stringValue(payload.runId) === review.runId &&
      (stringValue(payload.reviewId) === review.reviewId || stringValue(payload.sourcePlanId) === review.sourcePlanId);
  });
}

function reviewDecisionEvent(
  sessionId: string,
  review: SessionReviewContext,
  status: 'accepted' | 'needsRevision' | 'rejected',
  content: string,
  continuationRequested: boolean,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'review_summary',
    payload: {
      title: '审查',
      summary: status === 'accepted' ? '用户已通过 Review，本批次结束。' : '用户要求补充或修改。',
      content,
      status,
      runId: review.runId,
      reviewId: review.reviewId,
      sourcePlanId: review.sourcePlanId,
      confirmable: false,
      continuationRequested,
      continuationCount: review.continuations.length,
      continuations: review.continuations,
      channel: status === 'accepted' ? 'progress' : 'final',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function acceptedReviewContent(review: SessionReviewContext): string {
  const lines = [
    '## Review 已通过',
    '',
    '用户已通过当前批次 Review；Kernel facts 已作为本批次事实源保留。',
    '',
    '### 后续意图',
  ];
  if (!review.continuations.length) {
    lines.push('- 当前计划没有登记后续批次。');
  } else {
    lines.push(`- 当前计划登记了 ${review.continuations.length} 个后续意图。Review 通过只记录这些意图，不会自动生成或执行下一批。`);
    for (const continuation of review.continuations.slice(0, 6)) lines.push(`- ${continuationSummary(continuation)}`);
  }
  lines.push('', '### 决策边界', '- Review 通过只关闭当前批次，并等待用户下一步输入。', '- 如果需要继续后续批次，请在输入框明确描述下一步；系统会重新组装上下文并生成新的 Plan。');
  return lines.join('\n');
}

function reviewRevisionRequest(review: SessionReviewContext, guidance?: string): string {
  const continuations = review.continuations.map(continuationSummary).filter(Boolean);
  return [
    '根据用户 Review 修订意见，重新理解需求并生成下一批可审查 Plan。',
    '这是一轮 Review revise，不是 Review accept；不得把用户修订意见当成已授权执行。',
    '上一批 Plan、Review guidance、continuation expectations 都是 intentContext；只有 Kernel facts、ToolCompleted(ok=true)、WorkUnitCompleted 或 ResourcePacket 才能作为已生成文件事实。',
    guidance?.trim() ? `用户 Review 修订意见：\n${guidance.trim()}` : '用户 Review 修订意见：用户要求补充或修改当前批次。',
    review.content ? `上一批 Review 卡内容：\n${review.content}` : '',
    review.facts.length ? `上一批 Kernel facts：\n${review.facts.join('\n')}` : '上一批 Kernel facts：当前 Review 没有登记可复用事实。',
    review.userPlan ? `上一批 Plan intent：\n${review.userPlan}` : '',
    continuations.length ? `上一批 continuation intent：\n${continuations.map((item) => `- ${item}`).join('\n')}` : '',
    [
      '下一步要求：',
      '- 如需基于现有代码继续修改，先用 resourceRequest 读取相关文件事实，例如构建脚本、入口源码、头文件、测试或容器配置。',
      '- 然后输出新的详细 Agent Protocol v3 actionBundle。',
      '- 每个 workspace.write action 必须引用本轮 codeBlocks 的 sourceBlockId。',
      '- 新 Plan 等待用户确认，不要假定已经执行。',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function continuationSummary(value: unknown): string {
  const record = objectRecord(value);
  return stringValue(record?.title) ?? stringValue(record?.description) ?? stringValue(record?.id) ?? clipJson(value, 160);
}

function traceEvent(
  sessionId: string,
  kind: AgentEvent['kind'],
  summary: string,
  ts: string,
  id: string,
  extra: Record<string, unknown>
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind,
    payload: {
      title: 'Session decision',
      summary,
      status: 'noop',
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      ...extra,
    },
  };
}

function findRequirementConfirmation(events: AgentEvent[], runId?: string, requirementId?: string): AgentEvent | null {
  return [...events].reverse().find((event) => {
    if (event.kind !== 'requirement_confirmation') return false;
    const payload = objectRecord(event.payload);
    if (!payload || payload.confirmable !== true) return false;
    if (runId && stringValue(payload.runId) !== runId) return false;
    if (requirementId && stringValue(payload.requirementId) !== requirementId) return false;
    return stringValue(payload.status) === 'waitingUserConfirmation';
  }) ?? null;
}

function requirementDecisionEvent(
  sessionId: string,
  event: AgentEvent,
  decision: 'accept' | 'reject' | 'revise',
  guidance: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  const payload = objectRecord(event.payload) ?? {};
  return {
    id,
    sessionId,
    ts,
    kind: 'requirement_decision',
    payload: {
      title: 'Requirement decision',
      summary: decision === 'accept' ? '用户已确认需求理解。' : decision === 'revise' ? '用户要求修订需求理解。' : '用户拒绝当前需求理解。',
      status: decision === 'accept' ? 'accepted' : decision === 'revise' ? 'needsRevision' : 'rejected',
      runId: stringValue(payload.runId),
      requirementId: stringValue(payload.requirementId),
      decision,
      guidance,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function requirementRecordFromEvent(event: AgentEvent, status: RequirementRecord['status']): RequirementRecord | undefined {
  const payload = objectRecord(event.payload);
  const raw = objectRecord(payload?.requirement);
  if (!raw) return undefined;
  const checklist = objectRecord(raw.checklist);
  return {
    requirementId: stringValue(raw.requirementId) ?? stringValue(payload?.requirementId) ?? event.id,
    sessionId: stringValue(raw.sessionId) ?? event.sessionId,
    initialUserRequest: stringValue(raw.initialUserRequest) ?? stringValue(payload?.initialUserRequest) ?? stringValue(payload?.originalUserRequest) ?? '',
    checklist: checklist ? {
      goal: stringValue(checklist.goal) ?? '',
      explicitTasks: stringArray(checklist.explicitTasks),
      inferredTasks: stringArray(checklist.inferredTasks),
      outOfScope: stringArray(checklist.outOfScope),
      affectedAreaCandidates: stringArray(checklist.affectedAreaCandidates),
      resourceRequests: stringArray(checklist.resourceRequests),
      acceptanceCriteriaCandidates: stringArray(checklist.acceptanceCriteriaCandidates),
      clarificationQuestions: stringArray(checklist.clarificationQuestions),
      riskNotes: stringArray(checklist.riskNotes),
    } satisfies RequirementChecklist : undefined,
    status,
    createdAt: stringValue(raw.createdAt) ?? event.ts,
    updatedAt: new Date().toISOString(),
  };
}

function requirementOriginalRequest(event: AgentEvent): string {
  const payload = objectRecord(event.payload);
  return stringValue(payload?.originalUserRequest) ?? requirementRecordFromEvent(event, 'confirmed')?.initialUserRequest ?? '';
}

function requirementAttachments(event: AgentEvent): AgentContextAttachment[] {
  const payload = objectRecord(event.payload);
  return Array.isArray(payload?.attachments)
    ? payload.attachments.filter((item): item is AgentContextAttachment => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
}

function clipJson(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return clip(text ?? '', maxChars);
}

function repairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  invalidOutput: string,
  parseError: { code: string; message: string }
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Do not add execution facts, permissions, or tool results.',
        'Repair once using the original request context, ResourcePacket facts, invalid output, and parser error.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        `Parser error code: ${parseError.code}`,
        `Parser error message: ${parseError.message}`,
        'Invalid model output:',
        fenced(invalidOutput),
      ].join('\n\n'),
    },
  ];
}

function actionBundleCompactionRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  reason: string,
  invalidOutput: string
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 implementation batch repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'If proposing executable work, return kind="actionBundle" for only the next small reviewable implementation batch.',
        `Batch budget: at most ${MAX_ACTION_BUNDLE_CODE_BLOCKS} codeBlocks, at most ${MAX_ACTION_BUNDLE_ACTIONS} actions, at most ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} bytes total codeBlock content, and at most ${MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES} bytes per codeBlock.`,
        'Put remaining work into actionBundle.continuationExpectations; do not emit the full implementation in one response.',
        'If current facts are insufficient, return kind="resourceRequest" using manifestEntryId or rootId+path under the listed conversation roots.',
        'Do not claim execution, permissions, tests passed, or task completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Implementation batch context:',
        fenced(JSON.stringify(state.implementationBatch, null, 2)),
        `Repair reason: ${reason}`,
        'Invalid or empty model output:',
        fenced(invalidOutput || '[empty response]'),
      ].join('\n\n'),
    },
  ];
}

function resourceRequestRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  resolution: ResourceRequestResolution
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 resource request repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Use kind="answer" if the available ResourcePacket facts are enough.',
        'Use kind="resourceRequest" only when requesting manifestEntryId or root-relative path under the listed conversation roots.',
        'Do not invent arbitrary absolute local paths.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Invalid or unresolved resourceRequest proposal:',
        fenced(JSON.stringify(proposal.payload, null, 2)),
        'Resolution diagnostic:',
        fenced(resourceResolutionDiagnostic(resolution)),
      ].join('\n\n'),
    },
  ];
}

function planReviewRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  report: Record<string, unknown>
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 plan review repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Repair the actionBundle so Kernel PlanReview can evaluate concrete completion evidence.',
        'Do not claim execution, permissions, tests passed, or task completion.',
        'Do not add capabilities or expand scope unless the Kernel report explicitly requires it.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Original ProposalEnvelope:',
        fenced(JSON.stringify(proposal, null, 2)),
        'Kernel PlanReview report:',
        fenced(JSON.stringify(report, null, 2)),
        'Repair requirement:',
        fenced('For side-effect actions, include a detailed Markdown userPlan with Summary, Key Changes, Interfaces, Test Plan, and Assumptions sections. Include non-empty actionBundle.validationExpectations and actionBundle.reviewExpectations. Each validation expectation must describe evidence Kernel or the user can inspect after execution.'),
      ].join('\n\n'),
    },
  ];
}

function shouldRequestRequirementConfirmation(
  input: SessionDriverLoopInput,
  _state: SessionDriverLoopRunState
): boolean {
  if (input.confirmedRequirement) return false;
  const mode = input.requirementConfirmationMode ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return false;
}

function requirementRecordFromProposal(
  proposal: ProposalEnvelope,
  input: SessionDriverLoopInput,
  state: SessionDriverLoopRunState,
  timestamp: string
): RequirementRecord {
  const draft = objectRecord(proposal.payload) ?? {};
  const decisionOptions = Array.isArray(draft.options)
    ? draft.options
      .map((item) => objectRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => {
        const label = stringValue(item.label) ?? stringValue(item.id) ?? 'option';
        const description = stringValue(item.description);
        const recommended = item.recommended === true ? '（推荐）' : '';
        return [label + recommended, description].filter(Boolean).join('：');
      })
      .filter(Boolean)
    : [];
  const requirementId = stringValue(draft.requirementId)
    ?? stringValue(draft.id)
    ?? proposal.proposalId
    ?? `requirement-${state.runId}`;
  const checklist: RequirementChecklist = {
    goal: stringValue(draft.goal) ?? stringValue(draft.summary) ?? stringValue(draft.reason) ?? input.content,
    explicitTasks: stringArrayValue(draft.scope)
      .concat(stringArrayValue(draft.explicitTasks))
      .concat(decisionOptions)
      .filter(Boolean),
    inferredTasks: stringArrayValue(draft.inferredTasks)
      .concat(stringArrayValue(draft.constraints))
      .filter(Boolean),
    outOfScope: stringArrayValue(draft.outOfScope).concat(stringArrayValue(draft.nonGoals)),
    affectedAreaCandidates: stringArrayValue(draft.affectedAreas)
      .concat(stringArrayValue(draft.affectedAreaCandidates)),
    resourceRequests: stringArrayValue(draft.resourceRequests),
    acceptanceCriteriaCandidates: stringArrayValue(draft.acceptanceCriteria)
      .concat(stringArrayValue(draft.acceptanceCriteriaCandidates)),
    clarificationQuestions: stringArrayValue(draft.openQuestions)
      .concat(stringArrayValue(draft.clarificationQuestions)),
    riskNotes: stringArrayValue(draft.risks).concat(stringArrayValue(draft.riskNotes)),
  };
  return {
    requirementId,
    sessionId: state.sessionId,
    initialUserRequest: input.content,
    checklist,
    status: 'probing',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requirementConfirmationEvent(input: {
  sessionId: string;
  runId: string;
  requirement: RequirementRecord;
  proposal: ProposalEnvelope;
  originalUserRequest: string;
  attachments: AgentContextAttachment[];
  ts: string;
  id: string;
}): AgentEvent {
  const content = renderRequirementConfirmationMarkdown(input.requirement);
  return {
    id: input.id,
    sessionId: input.sessionId,
    ts: input.ts,
    kind: 'requirement_confirmation',
    payload: {
      title: '用户介入请求',
      summary: requirementSummary(input.requirement),
      content,
      status: 'waitingUserConfirmation',
      confirmable: true,
      runId: input.runId,
      requirementId: input.requirement.requirementId,
      requirement: input.requirement,
      decisionRequest: input.proposal.payload,
      proposalId: input.proposal.proposalId,
      originalUserRequest: input.originalUserRequest,
      attachments: input.attachments,
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function renderRequirementConfirmationMarkdown(requirement: RequirementRecord): string {
  const checklist = requirement.checklist;
  const sections = [
    ['目标', checklist?.goal ? [checklist.goal] : []],
    ['范围', checklist?.explicitTasks ?? []],
    ['非目标', checklist?.outOfScope ?? []],
    ['约束', checklist?.inferredTasks ?? []],
    ['风险点', checklist?.riskNotes ?? []],
    ['验收标准', checklist?.acceptanceCriteriaCandidates ?? []],
    ['仍不明确的问题', checklist?.clarificationQuestions ?? []],
  ] as const;
  return sections
    .map(([heading, items]) => {
      const body = items.length
        ? items.map((item) => `- ${item}`).join('\n')
        : '- 暂无。';
      return `## ${heading}\n${body}`;
    })
    .join('\n\n');
}

function requirementSummary(requirement: RequirementRecord): string {
  return requirement.checklist?.goal || requirement.initialUserRequest;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeParseError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPlanParseError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'parse_failed', message: error.message };
  return { code: 'parse_failed', message: String(error) };
}

function collectReasoning(result: LlmChatResult): string {
  const chunks = result.chunks
    .filter((chunk) => chunk.type === 'reasoning_delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  return result.assistantMessage?.reasoningContent ?? chunks;
}

function providerStageSummary(stage: string, phase: 'request' | 'response'): string {
  const label = stage
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (value) => value.toUpperCase());
  return phase === 'request'
    ? `${label}: 请求模型生成结构化回复。`
    : `${label}: 模型已返回，等待协议解析。`;
}

function redactForArchive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForArchive);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = redactForArchive(item);
      }
    }
    return output;
  }
  if (typeof value === 'string') return clip(value, 40000);
  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return ['secret', 'apikey', 'api_key', 'authorization', 'password', 'bearer', 'credential', 'cookie', 'token']
    .some((needle) => normalized.includes(needle));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function joinFsPath(root: string, child: string): string {
  const cleanRoot = root.replace(/\/+$/g, '');
  const cleanChild = child.replace(/^\/+/g, '');
  return `${cleanRoot}/${cleanChild}`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
