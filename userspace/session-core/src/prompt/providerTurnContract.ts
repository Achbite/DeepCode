import { actionBundleProtocolShapeLines, kernelCatalogToolIdList, resourceRequestProtocolShapeLine } from '../protocol/protocolContract.js';
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
  const common = [
    'Agent Protocol v3 schema digest: every live proposal is one JSON object with schemaVersion="deepcode.agent.protocol.v3", kind, outputLanguage, optional narration, and the kind-specific top-level field for the current ProviderTurnContract.',
    'Allowed proposal kinds only: answer, resourceRequest, decisionRequest, taskPlan, actionBundle, taskOutcome, diagnostic. reviewSummary is Session-generated from Kernel facts and must never be returned by the provider.',
    'answer top-level field: answer.format="markdown" and answer.content contains the user-visible response.',
    resourceRequestProtocolShapeLine(),
    'decisionRequest top-level field: decisionRequest.version/id/question/reason/summary/options/allowsFreeform; question must be a non-empty user-visible string. Use 2-3 mutually exclusive options with one recommended option.',
    'taskPlan top-level field: taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints. tasks[] is a Session-advanced ordered implementation queue. Do not output scheduling graph structures, source code, codeBlocks, actionBundle, commandBlocks, patches, or executable tool calls.',
    'taskOutcome top-level field: taskOutcome.version/id/taskId/status/reason/evidenceRefs. Use it only during accepted task execution when the current task is already sufficiently satisfied and no Kernel write/delete action is needed.',
    'diagnostic top-level field: diagnostic.version/id/severity/summary/details; diagnostic explains terminal protocol/context failure and never queues execution.',
  ];
  if (turnMode !== 'acceptedTaskExecution') {
    return [
      ...common,
      'Execution tool argument schema is withheld in this turn. If side-effect work is needed, output a taskPlan or focused resourceRequest/decisionRequest according to the ProviderTurnContract.',
    ].join('\n');
  }
  return [
    ...common,
    'actionBundle proposal top-level fields: userPlanMarkdown, codeBlocks, actionBundle. Use it only for the current accepted task.',
    ...actionBundleProtocolShapeLines(),
    'codeBlocks items use {blockId,targetPath,language?,operation?,contentLines,allowEmptyContent?}. contentLines is the only provider-facing source-code content carrier.',
    `actionBundle.actions[].toolId must use Kernel catalog ids: ${kernelCatalogToolIdList()}.`,
    'File operation actions must use fs.* toolIds. Action entries use actionId, toolId, args, and description; Kernel derives capability, permission, readSet/writeSet, and conflictKeys.',
    'Do not output capability, permissionLabels, accessScopes, resourceScope, commandBlocks, legacy implementationPlan, or payload wrapper fields.',
    'If the current accepted task is already satisfied by visible ResourceEvidence, generated artifact evidence, or confirmed task state and no action is needed, return taskOutcome with status="modelJudgedSufficient" instead of inventing an empty actionBundle.',
  ].join('\n');
}

export function providerVisibleWorkflowState(input: PromptEnvelopeBuilderInput): string {
  const mode = inferProviderTurnMode(input);
  const lines = [
    `Current workflow state: ${input.workflowState}.`,
    `Allowed proposals: ${input.allowedProposals.join(', ') || 'none'}.`,
    `Provider turn mode: ${mode}.`,
  ];
  if (mode === 'acceptedTaskExecution') {
    lines.push(`Kernel tool catalog visible for current accepted task as schema only, not authorization:\n${input.capabilityCatalogSummary || 'none'}`);
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
    return ['planning/read/decision turn: do not output executable tool args or actionBundle unless the ProviderTurnContract allowedKinds explicitly includes actionBundle for a tiny single-step side effect.'];
  }
  const record = objectRecord(input.currentTaskContext);
  const targets = stringArray(record?.targets);
  const capabilities = stringArray(record?.capabilities);
  const lines = [
    `currentTaskTargets=${targets.length ? targets.join(', ') : 'none'}`,
    `currentTaskCapabilities=${capabilities.length ? capabilities.join(', ') : 'none'}`,
    'Use only currentTaskTargets unless decisionRequest asks the user to expand current task scope.',
  ];
  if (capabilities.includes('fs.delete')) {
    lines.push('fs.delete intent: args.path must be one normalized current task target; directory delete requires args.targetKind="directory" and args.recursive=true only for an accepted directory target.');
  }
  if (capabilities.includes('fs.write')) {
    lines.push('fs.write intent: write concrete file paths under current task targets; use codeBlocks[].contentLines and args.sourceBlockId.');
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
