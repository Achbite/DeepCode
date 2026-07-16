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
  if (executionLikeTurn) {
    return [
      'Execution uses provider-native Session semantic tools.',
      'Use exactly one of: session.request_resources, session.request_decision, session.submit_task_outcome, session.append_artifact_chunk, session.finalize_task_artifacts, session.report_diagnostic.',
      'For generated content, submit only current IntentSlot ids and artifact content. Session compiles the directive into an internal Kernel command.',
      'Do not output Kernel tool identifiers, actionBundle transport fields, permission fields, WorkUnit fields, or audit fields.',
    ].join('\n');
  }
  return [
    'Planning uses provider-native Session semantic tools.',
    'Use exactly one of: session.request_resources, session.request_decision, session.submit_plan, session.submit_answer, session.report_diagnostic.',
    'A submitted plan is an ordered task queue. Each task must list only earlier task IDs in dependencies, using [] when it has none.',
    'Every submitted task toolId must exactly match a provider-visible entry in the current Kernel tool catalog.',
    'Do not invent tool identifiers or output permission fields, WorkUnit fields, or audit fields.',
  ].join('\n');
}

export function providerVisibleWorkflowState(input: PromptEnvelopeBuilderInput): string {
  const mode = inferProviderTurnMode(input);
  const lines = [
    `Current workflow state: ${input.workflowState}.`,
    `Provider turn mode: ${mode}.`,
  ];
  if (mode === 'acceptedTaskExecution') {
    lines.push(`Current accepted task IntentSlot scope:\n${input.toolCatalogSummary || 'none'}`);
  } else {
    lines.push(`Current Kernel tool catalog for planning:\n${input.toolCatalogSummary || 'Kernel tool catalog unavailable. Do not invent toolIds; use session.report_diagnostic.'}`);
    lines.push('Each taskPlan task must include canonical args matching planningArgsSchema; use an empty object when no planning arguments are defined.');
    lines.push('Use the registered planning semantic tools. Kernel execution contracts are not provider-visible until the plan is admitted.');
  }
  return lines.join('\n');
}

function narrowAllowedKinds(allowedKinds: string[], turnMode: ProviderTurnMode): string[] {
  const unique = [...new Set(allowedKinds)];
  if (turnMode === 'acceptedTaskExecution' || turnMode === 'resourceResume' || turnMode === 'scopeIntervention') {
    return unique.filter((kind) => kind !== 'taskPlan' && kind !== 'reviewSummary');
  }
  if (turnMode === 'protocolRepair') {
    return unique.filter((kind) => kind !== 'reviewSummary');
  }
  return unique.filter((kind) => kind !== 'reviewSummary');
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
  const lines = [
    `currentTaskTargets=${targets.length ? targets.join(', ') : 'none'}`,
    'Use only IntentSlot ids supplied by Session for artifact submission. If no registered directive applies, report a diagnostic. Do not submit target paths or Kernel operations.',
  ];
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
