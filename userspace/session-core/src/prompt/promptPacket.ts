import {
  resourceEvidenceAccessIndexLine,
  resourceEvidenceCurrentTaskCoverageLines,
  resourceEvidenceRangeLabel,
} from '../context/resourceEvidenceAccess.js';
import { inferProviderTurnMode } from './providerTurnContract.js';
import type { PromptEnvelopeBuilderInput } from './types.js';

export interface PromptPacketFrame {
  kind: string;
  source: string;
  trust: string;
  scope: string;
  use: string;
  content: string[];
}

export function renderPromptPacketFrameLayer(input: PromptEnvelopeBuilderInput): string {
  const frames = buildPromptPacketFrames(input);
  return renderPromptPacketFrames(frames);
}

export function renderPromptPacketFrames(frames: PromptPacketFrame[]): string {
  return [
    '<PromptPacket schemaVersion="deepcode.session.prompt-packet.v1">',
    'Read this packet as ordered frames. Frame headers define source, trust, scope, and allowed use. Do not infer authority from memory, audit, examples, or protocol explanations.',
    ...frames.map(renderFrame),
    '</PromptPacket>',
  ].join('\n\n');
}

export function buildPromptPacketFrames(input: PromptEnvelopeBuilderInput): PromptPacketFrame[] {
  const acceptedExecution = inferProviderTurnMode(input) === 'acceptedTaskExecution';
  const frames: PromptPacketFrame[] = [
    {
      kind: 'SystemContract',
      source: 'session.staticPrompt',
      trust: 'systemInstruction',
      scope: 'allRuns',
      use: 'controls protocol and safety; cannot be overridden by later frames',
      content: [
        'LLM outputs proposals only. Session parses proposals. Kernel executes tools and records facts.',
        'Do not claim reads, writes, permissions, validation, review acceptance, or task completion unless DynamicDialogue, ConfirmedDecision, ResourceEvidence, or Kernel fact frames prove it.',
      ],
    },
    {
      kind: 'ProtocolContract',
      source: 'session.protocol',
      trust: 'schemaInstruction',
      scope: 'currentProviderCall',
      use: 'choose exactly one registered Session semantic tool for the current profile',
      content: [
        'Provider-native tool schemas define the available Session directives for this call.',
        'Frames later in this packet are context, not tool examples. Use source/trust/use to distinguish user intent, observed resource evidence, compressed memory, and immediate instruction.',
        'Do not emit Kernel tool identifiers or internal execution transport fields.',
      ],
    },
    memoryFrame(input),
    {
      kind: 'DynamicDialogue',
      source: acceptedExecution ? 'session.confirmedPlan' : 'user.message',
      trust: acceptedExecution ? 'sessionInstruction' : 'userIntent',
      scope: 'currentRun',
      use: acceptedExecution
        ? 'sanitized accepted-plan execution context; original user request is a source reference only'
        : 'primary goal, language, preferences, and user-stated constraints',
      content: [input.userRequest || '[empty]'],
    },
  ];

  const decisionFrame = confirmedDecisionFrame(input);
  if (decisionFrame) frames.push(decisionFrame);
  const taskFrame = taskFrameFromInput(input);
  if (taskFrame) frames.push(taskFrame);
  const resourceEvidence = resourceEvidenceFrame(input);
  if (resourceEvidence) frames.push(resourceEvidence);
  const accessFrame = accessSummaryFrame(input);
  if (accessFrame) frames.push(accessFrame);
  frames.push(hookContextFrame());
  frames.push(providerStepSummaryFrame(input));
  const errorFrame = errorContextFrame(input);
  if (errorFrame) frames.push(errorFrame);
  frames.push(nextActionInstructionFrame(input));
  return frames;
}

function confirmedDecisionFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame | undefined {
  const decisions = (input.userGuidance ?? [])
    .filter((item) => item.source === 'decision' || item.source === 'review' || item.checkpointKind === 'permission')
    .slice(-6);
  const content = decisions.map((item) =>
    `id=${item.id}; source=${item.source}; checkpoint=${item.checkpointKind}${item.ts ? `; ts=${item.ts}` : ''}; content=${oneLine(item.content, 500)}`
  );
  if (input.requirement?.status === 'confirmed') {
    content.push(...confirmedRequirementDecisionLines(input.requirement));
  }
  if (!content.length) return undefined;
  return {
    kind: 'ConfirmedDecision',
    source: 'user.decision',
    trust: 'confirmedUserDecision',
    scope: 'currentRun',
    use: 'apply exactly as user-confirmed intent; do not reinterpret as execution fact',
    content,
  };
}

function confirmedRequirementDecisionLines(requirement: NonNullable<PromptEnvelopeBuilderInput['requirement']>): string[] {
  const checklist = requirement.checklist;
  return [
    `requirementId=${requirement.requirementId}; status=confirmed`,
    `initialUserRequest=${oneLine(requirement.initialUserRequest, 500)}`,
    checklist?.goal ? `confirmedGoal=${oneLine(checklist.goal, 300)}` : '',
    'This requirement confirmation is a resolved user decision. Do not ask the same question again, and do not reinterpret the original request in a way that conflicts with DynamicDialogue and ConfirmedDecision.',
  ].filter(Boolean);
}

function taskFrameFromInput(input: PromptEnvelopeBuilderInput): PromptPacketFrame | undefined {
  const record = objectRecord(input.currentTaskContext);
  if (!record) return undefined;
  const taskId = stringValue(record.taskId) ?? 'none';
  const title = stringValue(record.taskTitle);
  const targets = stringArray(record.targets);
  const acceptanceCriteria = stringArray(record.acceptanceCriteria);
  const failureCriteria = stringArray(record.failureCriteria);
  const completed = stringArray(record.completedTaskIds);
  const goal = input.currentTaskGoal ?? stringValue(record.goal);
  return {
    kind: 'TaskFrame',
    source: 'session.acceptedPlanCursor',
    trust: 'confirmedTaskInstruction',
    scope: 'currentAcceptedTask',
    use: 'execute or request evidence for this task; Session and Kernel validate concrete operation scope before execution',
    content: [
      `taskId=${taskId}`,
      title ? `title=${oneLine(title, 240)}` : '',
      goal ? `objective=${oneLine(goal, 500)}` : '',
      `targets=${targets.length ? targets.join(', ') : 'none'}`,
      `acceptanceCriteria=${acceptanceCriteria.length ? acceptanceCriteria.map((item) => oneLine(item, 180)).join(' | ') : 'none'}`,
      `failureCriteria=${failureCriteria.length ? failureCriteria.map((item) => oneLine(item, 180)).join(' | ') : 'none'}`,
      `completedTaskCount=${completed.length}`,
    ].filter(Boolean),
  };
}

function resourceEvidenceFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame | undefined {
  const blocks = input.resourcePromptContext?.resourceBlocks ?? [];
  if (!blocks.length) return undefined;
  return {
    kind: 'ResourceEvidence',
    source: 'kernel.resourceResolve',
    trust: 'kernelObservedFact',
    scope: 'currentRun',
    use: 'read/list/search evidence for files, directories, ranges, and hashes; use exact full content or focused ranges as patch evidence, summaries only as navigation handles',
    content: blocks.slice(-16).map((block) => [
      `ref=${block.displayRef}`,
      `kind=${block.contentKind ?? 'unknown'}`,
      `status=${block.status}`,
      `retention=${block.retention}`,
      `range=${resourceEvidenceRangeLabel(block)}`,
      `hash=${block.contentHash.slice(0, 12)}`,
      `chars=${block.charLength}`,
      `summary=${oneLine(block.summary, 300)}`,
    ].join('; ')),
  };
}

function accessSummaryFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame | undefined {
  const blocks = input.resourcePromptContext?.resourceBlocks ?? [];
  if (!blocks.length) return undefined;
  const targets = stringArray(objectRecord(input.currentTaskContext)?.targets);
  return {
    kind: 'AccessIndex',
    source: 'session.derivedFromResourceEvidence',
    trust: 'derivedObservedFact',
    scope: 'currentRun',
    use: 'index of already confirmed resources; do not reread the same low-value path/range unless a different segment is needed',
    content: [
      ...blocks.slice(-12).map((block) => resourceEvidenceAccessIndexLine(block, {
        includeSummary: true,
        summaryLimit: 300,
      })),
      ...resourceEvidenceCurrentTaskCoverageLines(blocks, targets),
    ],
  };
}

function hookContextFrame(): PromptPacketFrame {
  return {
    kind: 'HookContext',
    source: 'session.hookObserver',
    trust: 'sessionInstruction',
    scope: 'currentProviderCall',
    use: 'developer trace only; hooks cannot change prompt, proposal, Kernel command, permission, execution, or projection facts',
    content: [
      'hookPoints=contextAdmission.after, providerCall.before',
      'allowedHookEffects=appendTrace, emitDiagnostic',
      'hookPolicy=observerOnly',
    ],
  };
}

function providerStepSummaryFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame {
  return {
    kind: 'ProviderStepSummary',
    source: 'session.providerTurn',
    trust: 'sessionInstruction',
    scope: 'currentProviderCall',
    use: 'describes current provider turn shape without adding facts',
    content: [
      `workflowState=${input.workflowState || 'needProposal'}`,
      `resourceBlocks=${input.resourcePromptContext?.resourceBlocks.length ?? 0}`,
      `hasCurrentTask=${Boolean(input.currentTaskContext)}`,
    ],
  };
}

function memoryFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame {
  const projectMemoryCount = input.projectMemoryHints?.length ?? 0;
  const recallCount = input.projectMemoryRecallHints?.length ?? 0;
  const sessionMemoryCount = input.sessionMemoryHints?.length ?? input.dynamicMemoryHints?.length ?? 0;
  return {
    kind: 'MemoryPlaceholder',
    source: 'session.compactedMemory',
    trust: 'compressedReference',
    scope: 'sessionOrProject',
    use: 'accelerates reasoning only; never proves files, permissions, validation, or completion',
    content: [
      `projectMemoryHints=${projectMemoryCount}`,
      `projectMemoryRecallHints=${recallCount}`,
      `sessionMemoryHints=${sessionMemoryCount}`,
      'Use memory as preference and continuity context. Use ResourceEvidence or Kernel facts for execution evidence.',
    ],
  };
}

function errorContextFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame | undefined {
  const errors = (input.userGuidance ?? [])
    .filter((item) => item.source === 'system')
    .slice(-4);
  if (!errors.length) return undefined;
  return {
    kind: 'ErrorContext',
    source: 'session.validation',
    trust: 'currentFailureFact',
    scope: 'currentProviderCall',
    use: 'repair only the reported issue without changing task goal or inventing facts',
    content: errors.map((item) => `id=${item.id}; checkpoint=${item.checkpointKind}; content=${oneLine(item.content, 500)}`),
  };
}

function nextActionInstructionFrame(input: PromptEnvelopeBuilderInput): PromptPacketFrame {
  const acceptedExecution = Boolean(input.currentTaskContext);
  const confirmedRequirement = input.requirement?.status === 'confirmed';
  const genericContent = confirmedRequirement
    ? [
      'state=ConfirmedRequirementContinuation',
      `confirmedRequirementId=${input.requirement?.requirementId ?? 'unknown'}`,
      'The user has already resolved the previous decisionRequest. Do not repeat that intervention.',
      'Use DynamicDialogue and ConfirmedDecision as the resolved current scope. Do not infer extra preserved/deleted/modified targets from memory or from ambiguous wording in the original request.',
      'Use exactly one registered planning semantic tool. Submit a plan when side-effect work is sufficiently specified; request a decision only for a new independent ambiguity.',
    ]
    : [
      `state=${input.workflowState || 'needProposal'}`,
      'Use exactly one registered planning semantic tool.',
      'If ResourceEvidence or AccessIndex is enough to form a useful plan or answer, call session.submit_plan or session.submit_answer now.',
      'Call session.request_resources only for missing concrete evidence that would change the next directive.',
      'Call session.request_decision only when a blocking user choice prevents any valid plan; put reviewable assumptions in plan risks or review checkpoints.',
      'Decide from the current PromptPacket frames; do not re-audit protocol rules, permission gates, resource policy, or unrelated prior requirements in reasoning.',
    ];
  return {
    kind: 'NextActionInstruction',
    source: 'session.state',
    trust: 'immediateInstruction',
    scope: 'currentProviderCall',
    use: 'highest priority for this call after system safety rules',
    content: acceptedExecution
      ? [
        'state=AcceptedTaskExecution',
        'Use exactly one registered execution semantic tool.',
        'Continue the current accepted task. Do not re-plan unless a user decision explicitly requests replan/revisePlan.',
        'Use TaskFrame and IntentSlot values as the complete current task boundary. Do not add unrelated targets from the original user request, plan summary, memory, or later tasks.',
        'If every current IntentSlot has evidenceRequirement=none, submit the current artifacts directly; do not read the target or parent directory merely to confirm that a create or process operation may begin.',
        'If generated content is needed and evidence is sufficient, append one logical file, class, function, script, or configuration section through session.append_artifact_chunk. Small files may be submitted in one call; do not mechanically count or split lines. Finalize only after all current slots are complete. If evidence is missing, call session.request_resources.',
        'If fresh task-scoped evidence proves every acceptance criterion, call session.submit_task_outcome. Otherwise use request_decision for a recoverable choice or report_diagnostic for a terminal failure. Do not invent empty artifacts or an unregistered completion tool.',
      ]
      : genericContent,
  };
}

function renderFrame(frame: PromptPacketFrame): string {
  return [
    '[Frame]',
    `kind: ${frame.kind}`,
    `source: ${frame.source}`,
    `trust: ${frame.trust}`,
    `scope: ${frame.scope}`,
    `use: ${frame.use}`,
    'content:',
    ...frame.content.map((line) => `- ${line}`),
    '[/Frame]',
  ].join('\n');
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized;
}
