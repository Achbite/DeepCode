import { renderProviderTurnContract, type RenderedProviderTurnContract, type ProviderTurnMode } from './providerTurnContract.js';
import type { PromptPacketFrame } from './promptPacket.js';

export interface RepairProviderTurnContractCurrentTask {
  taskId?: string;
  taskTitle?: string;
  goal?: string;
  targets?: string[];
  toolIds?: string[];
}

export interface RepairProviderTurnContractInput {
  turnMode: ProviderTurnMode;
  allowedKinds: string[];
  requiredKind?: string;
  repairPolicy?: RenderedProviderTurnContract['repairPolicy'];
  errorLines?: string[];
  acceptedContext?: Record<string, unknown>;
  currentTaskContext?: RepairProviderTurnContractCurrentTask;
  completedTaskCount?: number;
}

export class RepairProviderTurnContractBuilder {
  render(input: RepairProviderTurnContractInput): string {
    const acceptedContext = input.acceptedContext ?? {};
    const currentTask = objectRecord(acceptedContext.currentTask);
    const operations = Array.isArray(acceptedContext.currentTaskOperations)
      ? acceptedContext.currentTaskOperations.length
      : 0;
    const templates = Array.isArray(acceptedContext.currentTaskActionTemplates)
      ? acceptedContext.currentTaskActionTemplates.length
      : 0;
    const frames: PromptPacketFrame[] = [
      {
        kind: 'SystemContract',
        source: 'session.staticPrompt',
        trust: 'systemInstruction',
        scope: 'allRuns',
        use: 'repair the proposal only; do not create facts, permissions, or task completion',
        content: [
          'Session parses proposals. Kernel executes tools and records facts.',
          'Repair output must be a proposal only, not an explanation of the error.',
        ],
      },
      {
        kind: 'ProtocolContract',
        source: 'session.protocol',
        trust: 'schemaInstruction',
        scope: 'currentProviderCall',
        use: 'choose exactly one allowed proposal kind for this repair call',
        content: [
          `Allowed proposal kinds for this call: ${input.allowedKinds.join(', ') || 'none'}.`,
          input.requiredKind ? `Required proposal kind: ${input.requiredKind}.` : 'No required proposal kind; choose the narrowest valid allowed kind.',
          'Do not return taskPlan during accepted task execution repair.',
        ].filter(Boolean),
      },
    ];
    if (input.currentTaskContext || currentTask) {
      frames.push({
        kind: 'TaskFrame',
        source: 'session.acceptedPlanCursor',
        trust: 'confirmedTaskInstruction',
        scope: 'currentAcceptedTask',
        use: 'repair only this current task; Session and Kernel validate concrete operation scope before execution',
        content: [
          `taskId=${input.currentTaskContext?.taskId ?? stringValue(currentTask?.taskId) ?? 'none'}`,
          `title=${oneLineText(input.currentTaskContext?.taskTitle ?? stringValue(currentTask?.title) ?? '', 240) || 'none'}`,
          `objective=${oneLineText(input.currentTaskContext?.goal ?? stringValue(currentTask?.objective) ?? '', 500) || 'none'}`,
          `targets=${input.currentTaskContext?.targets?.join(', ') || stringArrayValue(currentTask?.targets).join(', ') || 'none'}`,
          `toolIds=${input.currentTaskContext?.toolIds?.join(', ') || stringValue(currentTask?.toolId) || 'none'}`,
          `completedTaskCount=${input.completedTaskCount ?? 0}`,
          `currentTaskOperations=${operations}`,
          `currentTaskActionTemplates=${templates}`,
        ],
      });
    }
    if (input.errorLines?.length) {
      frames.push({
        kind: 'ErrorContext',
        source: 'session.validation',
        trust: 'currentFailureFact',
        scope: 'currentProviderCall',
        use: 'repair only the reported issue without changing the current task goal',
        content: input.errorLines.map((line) => oneLineText(line, 500)),
      });
    }
    frames.push({
      kind: 'NextActionInstruction',
      source: 'session.state',
      trust: 'immediateInstruction',
      scope: 'currentProviderCall',
      use: 'highest priority for this repair call after system safety rules',
      content: repairNextActionInstructionLines(input),
    });
    return renderProviderTurnContract({
      schemaVersion: 'deepcode.session.provider-turn-contract.v1',
      turnMode: input.turnMode,
      allowedKinds: input.allowedKinds,
      requiredKind: input.requiredKind,
      repairPolicy: input.repairPolicy ?? 'sameKindOnly',
      projectionVisibility: input.turnMode === 'protocolRepair' ? 'debugOnly' : 'normal',
      toolIntentTemplates: repairToolIntentTemplates(input, acceptedContext),
      frames,
    });
  }
}

function repairNextActionInstructionLines(input: {
  turnMode: ProviderTurnMode;
  allowedKinds: string[];
  requiredKind?: string;
}): string[] {
  const allowsActionBundle = input.allowedKinds.includes('actionBundle');
  const forbidden = allowsActionBundle
    ? 'taskPlan | reviewSummary'
    : 'actionBundle | taskPlan | reviewSummary';
  const nextAction = allowsActionBundle
    ? [
      'If executable work remains in current scope, output actionBundle.',
      'If no valid executable operation remains for the current task, output diagnostic with the blocking reason.',
      'If evidence is missing, output focused resourceRequest.',
      'If a concrete operation exceeds accepted scope, Session and Kernel will interrupt for user approval after proposal validation.',
    ].join(' ')
    : 'Do not output executable tool args. If side-effect work remains unaccepted, output taskPlan. If evidence is missing, output focused resourceRequest. If a user choice is needed, output decisionRequest.';
  return [
    `state=${input.turnMode}`,
    `allowedOutputs=${input.allowedKinds.join(' | ') || 'none'}`,
    input.requiredKind ? `requiredOutput=${input.requiredKind}` : '',
    'requiredSchemaVersion=deepcode.agent.protocol.v4',
    `forbiddenOutputs=${forbidden}`,
    'Return exactly one valid Agent Protocol v4 JSON object. No prose, markdown fences, or protocol explanation.',
    nextAction,
  ].filter(Boolean);
}

function repairToolIntentTemplates(
  input: RepairProviderTurnContractInput,
  acceptedContext: Record<string, unknown>
): string[] {
  if (!input.allowedKinds.includes('actionBundle')) {
    return [];
  }
  const templates = Array.isArray(acceptedContext.currentTaskActionTemplates)
    ? acceptedContext.currentTaskActionTemplates
    : [];
  if (templates.length) {
    return [
      'Use currentTaskActionTemplates only for the current accepted task.',
      clip(JSON.stringify(templates, null, 2), 2_000),
    ];
  }
  const targets = input.currentTaskContext?.targets ?? [];
  const toolIds = input.currentTaskContext?.toolIds ?? [];
  return [
    `currentTaskTargets=${targets.length ? targets.join(', ') : 'none'}`,
    `currentTaskToolIds=${toolIds.length ? toolIds.join(', ') : 'none'}`,
    'Do not infer additional targets from the original user request, memory, or invalid proposal.',
  ];
}

function oneLineText(value: string, maxChars: number): string {
  return clip(value.replace(/\s+/g, ' ').trim(), maxChars);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0
      ? [value.trim()]
      : [];
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
