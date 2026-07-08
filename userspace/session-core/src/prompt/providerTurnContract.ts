import { actionBundleProtocolShapeLines, resourceRequestProtocolShapeLine } from '../protocol/protocolContract.js';
import type { PromptEnvelopeBuilderInput } from './types.js';
import { buildPromptPacketFrames, renderPromptPacketFrames, type PromptPacketFrame } from './promptPacket.js';

export type ProviderTurnMode =
  | 'planning'
  | 'requirementDecision'
  | 'acceptedTaskExecution'
  | 'protocolRepair'
  | 'resourceResume'
  | 'scopeIntervention'
  | 'reviewAnswer';

export type ProviderRepairPolicy =
  | 'sameKindOnly'
  | 'deterministicIntervention'
  | 'diagnosticOnly';

export interface RenderedProviderTurnContract {
  schemaVersion: 'deepcode.session.provider-turn-contract.v1';
  turnMode: ProviderTurnMode;
  allowedKinds: string[];
  requiredKind?: string;
  repairPolicy: ProviderRepairPolicy;
  projectionVisibility: 'normal' | 'debugOnly';
  toolIntentTemplates: string[];
  frames: PromptPacketFrame[];
}

export interface RenderedProviderTurnContractOptions {
  turnMode?: ProviderTurnMode;
  allowedKinds?: string[];
  requiredKind?: string;
  repairPolicy?: ProviderRepairPolicy;
  projectionVisibility?: RenderedProviderTurnContract['projectionVisibility'];
}

export function buildProviderTurnContract(
  input: PromptEnvelopeBuilderInput,
  options: RenderedProviderTurnContractOptions = {}
): RenderedProviderTurnContract {
  const turnMode = options.turnMode ?? inferProviderTurnMode(input);
  const allowedKinds = narrowAllowedKinds(options.allowedKinds ?? input.allowedProposals, turnMode);
  const scopedInput = { ...input, allowedProposals: allowedKinds };
  return {
    schemaVersion: 'deepcode.session.provider-turn-contract.v1',
    turnMode,
    allowedKinds,
    requiredKind: options.requiredKind,
    repairPolicy: options.repairPolicy ?? defaultRepairPolicy(turnMode),
    projectionVisibility: options.projectionVisibility ?? (turnMode === 'protocolRepair' ? 'debugOnly' : 'normal'),
    toolIntentTemplates: toolIntentTemplates(scopedInput, turnMode),
    frames: buildPromptPacketFrames(scopedInput),
  };
}

export function renderProviderTurnContractLayer(
  input: PromptEnvelopeBuilderInput,
  options: RenderedProviderTurnContractOptions = {}
): string {
  return renderProviderTurnContract(buildProviderTurnContract(input, options));
}

export function renderProviderTurnContract(contract: RenderedProviderTurnContract): string {
  return [
    '<ProviderTurnContract schemaVersion="deepcode.session.provider-turn-contract.v1">',
    `turnMode: ${contract.turnMode}`,
    `allowedKinds: ${contract.allowedKinds.join(', ') || 'none'}`,
    contract.requiredKind ? `requiredKind: ${contract.requiredKind}` : '',
    `repairPolicy: ${contract.repairPolicy}`,
    `projectionVisibility: ${contract.projectionVisibility}`,
    '[ToolIntentTemplates]',
    ...(contract.toolIntentTemplates.length ? contract.toolIntentTemplates.map((line) => `- ${line}`) : ['- none']),
    '[/ToolIntentTemplates]',
    renderPromptPacketFrames(contract.frames),
    '</ProviderTurnContract>',
  ].filter(Boolean).join('\n\n');
}

export function inferProviderTurnMode(input: PromptEnvelopeBuilderInput): ProviderTurnMode {
  if (input.currentTaskContext) return 'acceptedTaskExecution';
  if (input.workflowState === 'waiting_requirement_confirmation') return 'requirementDecision';
  if (input.workflowState === 'review' || input.workflowState === 'waiting_review') return 'reviewAnswer';
  return 'planning';
}

export function providerVisibleSchemaDigest(input: PromptEnvelopeBuilderInput): string {
  const turnMode = inferProviderTurnMode(input);
  const executionLikeTurn = turnMode === 'acceptedTaskExecution' || turnMode === 'resourceResume' || turnMode === 'scopeIntervention';
  const allowedKinds = new Set(narrowAllowedKinds(input.allowedProposals, turnMode));
  const visibleSchemaKinds = new Set(
    [...allowedKinds].filter((kind) => executionLikeTurn || (kind !== 'actionBundle' && kind !== 'taskOutcome'))
  );
  const schemaLines = [
    'Agent Protocol v3 current turn schema selector: one JSON object; choose one ProviderTurnContract.allowedKinds kind.',
    `Current schema digest covers only: ${[...visibleSchemaKinds].join(', ') || 'none'}. reviewSummary is Session-generated from Kernel facts and must never be returned by the provider.`,
    visibleSchemaKinds.has('answer')
      ? 'answer top-level field: answer.format="markdown"; answer.content is the user-visible response.'
      : '',
    visibleSchemaKinds.has('resourceRequest') ? resourceRequestProtocolShapeLine() : '',
    visibleSchemaKinds.has('decisionRequest')
      ? 'decisionRequest top-level field: decisionRequest.version/id/question/options/allowsFreeform; question must be a non-empty user-visible string; use 2-3 mutually exclusive options with one recommended option.'
      : '',
    visibleSchemaKinds.has('taskPlan')
      ? 'taskPlan top-level field: taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints. tasks[] is an ordered queue of reviewable batches, not one task per file; group related files/ops. Every task must include capability, concrete non-root target or targets, acceptanceCriteria, and failureCriteria. Use fs.write/fs.patch/fs.delete for file-system changes; no codeBlocks, actionBundle, commandBlocks, patches, source code, or graph structures.'
      : '',
    executionLikeTurn && visibleSchemaKinds.has('taskOutcome')
      ? 'taskOutcome top-level field: taskOutcome.version/id/taskId/status/reason/evidenceRefs; use only when the current accepted task is already sufficiently satisfied and no Kernel write/delete action is needed.'
      : '',
    visibleSchemaKinds.has('diagnostic')
      ? 'diagnostic top-level field: diagnostic.version/id/severity/summary/details; terminal explanation only, never execution.'
      : '',
  ].filter(Boolean);
  if (!executionLikeTurn) {
    return [
      ...schemaLines,
      'Execution-only proposal schema is withheld in this turn. For side-effect work, output taskPlan unless the final NextActionInstruction explicitly requires another allowed kind.',
    ].join('\n');
  }
  return [
    ...schemaLines,
    allowedKinds.has('actionBundle')
      ? [
        'actionBundle proposal top-level fields: userPlanMarkdown, codeBlocks, actionBundle. Use it only for the current accepted task.',
        ...actionBundleProtocolShapeLines(),
        'codeBlocks items use {blockId,targetPath,language?,operation?,contentLines,allowEmptyContent?}. contentLines is the only provider-facing source-code content carrier.',
        'When ToolIntentTemplates are present, actionBundle.actions[] should prefer those templates for the current task. Concrete adjacent operations needed for correctness may be included; Session and Kernel validate scope before execution.',
        'When no ToolIntentTemplates are present, use one currentTaskCapabilities id from this ProviderTurnContract and concrete targets required by the current task.',
        'File operation actions must use fs.* toolIds. Action entries use actionId, toolId, args, and description; Kernel derives capability, permission, readSet/writeSet, and conflictKeys.',
        'Do not output capability, permissionLabels, accessScopes, resourceScope, commandBlocks, legacy implementationPlan, or payload wrapper fields.',
      ].join('\n')
      : '',
    allowedKinds.has('taskOutcome')
      ? 'If the current accepted task is already satisfied by visible ResourceEvidence, generated artifact evidence, or confirmed task state and no action is needed, return taskOutcome with status="modelJudgedSufficient" instead of inventing an empty actionBundle.'
      : '',
  ].filter(Boolean).join('\n');
}

export function providerVisibleWorkflowState(input: PromptEnvelopeBuilderInput): string {
  const mode = inferProviderTurnMode(input);
  const lines = [
    `Current workflow state: ${input.workflowState}.`,
    `Allowed proposals: ${input.allowedProposals.join(', ') || 'none'}.`,
    `Provider turn mode: ${mode}.`,
  ];
  if (mode === 'acceptedTaskExecution') {
    lines.push(`Current accepted task tool intent scope:\n${input.capabilityCatalogSummary || 'none'}`);
  } else {
    lines.push('Kernel execution tool argument catalog is not visible in this turn. Use taskPlan operation intent, focused resourceRequest, decisionRequest, answer, or diagnostic as allowed.');
  }
  return lines.join('\n');
}

function narrowAllowedKinds(allowedKinds: string[], turnMode: ProviderTurnMode): string[] {
  const unique = [...new Set(allowedKinds)];
  if (turnMode === 'acceptedTaskExecution' || turnMode === 'resourceResume' || turnMode === 'scopeIntervention') {
    return unique.filter((kind) => kind !== 'taskPlan' && kind !== 'implementationPlan' && kind !== 'reviewSummary');
  }
  if (turnMode === 'protocolRepair') {
    return unique.filter((kind) => kind !== 'implementationPlan' && kind !== 'reviewSummary');
  }
  return unique.filter((kind) => kind !== 'implementationPlan' && kind !== 'reviewSummary');
}

function defaultRepairPolicy(turnMode: ProviderTurnMode): ProviderRepairPolicy {
  if (turnMode === 'protocolRepair') return 'sameKindOnly';
  if (turnMode === 'scopeIntervention') return 'deterministicIntervention';
  return 'diagnosticOnly';
}

function toolIntentTemplates(input: PromptEnvelopeBuilderInput, turnMode: ProviderTurnMode): string[] {
  if (turnMode !== 'acceptedTaskExecution' && turnMode !== 'resourceResume' && turnMode !== 'scopeIntervention') {
    return [];
  }
  const record = objectRecord(input.currentTaskContext);
  const targets = stringArray(record?.targets);
  const capabilities = stringArray(record?.capabilities);
  const lines = [
    `currentTaskTargets=${targets.length ? targets.join(', ') : 'none'}`,
    `currentTaskCapabilities=${capabilities.length ? capabilities.join(', ') : 'none'}`,
    'Prefer currentTaskTargets for actionBundle operations. If the current task needs a concrete adjacent target, include it explicitly; Session and Kernel validate scope before execution. Do not import unrelated targets from plan summary, memory, original user request, or later tasks.',
  ];
  if (capabilities.includes('fs.delete')) {
    lines.push('fs.delete intent: args.path must be one normalized current task target; directory delete requires args.targetKind="directory" and args.recursive=true only for an accepted directory target.');
  }
  if (capabilities.includes('fs.write')) {
    lines.push('fs.write intent: write complete replacement content for concrete current task paths; use codeBlocks[].contentLines and args.sourceBlockId. Do not request existing text only to replace the whole file.');
  }
  if (capabilities.includes('fs.patch')) {
    lines.push('fs.patch intent: request focused ResourceEvidence first unless exact current match text is already visible; args.patchSpec.match.text must copy Kernel-observed evidence.');
  }
  return lines;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

export function planningDecisionPolicyLines(): string[] {
  return [
    'Plan review is the normal confirmation checkpoint for reviewable implementation assumptions. During planning, prefer taskPlan with explicit assumptions, risks, and review checkpoints over decisionRequest for routine classifications, reversible cleanup choices, file organization details, or choices the user can approve or revise in the plan card.',
    'Use kind="decisionRequest" only when a blocking user choice is required before any valid taskPlan can be formed: mutually exclusive product or architecture direction, destructive scope not inferable from confirmed text, cross-workspace scope, permission boundary expansion, or validation authority change.',
  ];
}
