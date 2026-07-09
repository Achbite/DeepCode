import type { ProposalEnvelope } from '../protocol/types.js';
import type { ResourcePacket } from '../context/types.js';
import type { ProviderRepairMessageBuilder, ProviderRepairMessageState } from './ProviderRepairMessageBuilder.js';

// Resource resume must keep this allow-list aligned with the driver contract and repair parser.
export const ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS = [
  'actionBundle',
  'resourceRequest',
  'decisionRequest',
  'taskOutcome',
  'diagnostic',
] as const;

export interface AcceptedPlanResourceResumeAcceptedPlan {
  planId: string;
  completedTaskIds: string[];
  tasks: Array<{ taskId: string }>;
}

export interface AcceptedPlanResourceResumeCursor {
  currentTaskId?: string;
  completedTaskIds: string[];
  lastResourcePacketIds: string[];
}

export interface AcceptedPlanResourceResumeCurrentTask {
  goal: string;
  targets: string[];
  capabilities: string[];
  evidenceNeeds: string[];
}

export interface AcceptedPlanResourceResumePromptInput {
  repairState: ProviderRepairMessageState;
  acceptedPlan?: AcceptedPlanResourceResumeAcceptedPlan;
  cursor?: AcceptedPlanResourceResumeCursor;
  currentTask?: AcceptedPlanResourceResumeCurrentTask;
  requestProposal: ProposalEnvelope;
  packet: ResourcePacket;
}

export class AcceptedPlanResourceResumePromptBuilder {
  constructor(
    private readonly repairMessageBuilder: ProviderRepairMessageBuilder
  ) {}

  render(input: AcceptedPlanResourceResumePromptInput): string {
    const { acceptedPlan, cursor, currentTask, packet, requestProposal } = input;
    const resourceItems = packet.items.map((item) => {
      const record = objectRecord(item) ?? {};
      return {
        manifestEntryId: stringValue(record.manifestEntryId) ?? stringValue(record.id),
        path: stringValue(record.path) ?? stringValue(record.absolutePath) ?? stringValue(record.ref),
        kind: stringValue(record.contentKind) ?? stringValue(record.resolvedKind) ?? stringValue(record.kind),
        textPreview: clip(stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.fileText) ?? '', 1200),
      };
    });
    return [
      this.repairMessageBuilder.renderRepairProviderTurnContract(input.repairState, {
        turnMode: 'resourceResume',
        allowedKinds: [...ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS],
        repairPolicy: 'diagnosticOnly',
        errorLines: [`ResourcePacket ${packet.id} resolved ${packet.items.length} item(s) for the current accepted task.`],
      }),
      'Accepted-plan resource resume checkpoint.',
      'You are resuming the same accepted task after Session resolved read-only evidence. Do not restart planning, do not ask for already-confirmed scope, and do not claim execution facts.',
      'Before the final JSON proposal, stream visible edit drafts with <deepcode-part>{...}</deepcode-part> frames when generating long codeBlocks/actionBundles. These frames are draft ledger previews only; final workspace writes still come only from the complete actionBundle JSON.',
      'All user-visible natural language in narration, userPlanMarkdown, validation descriptions, and review guidance must follow the current user input language.',
      `Return exactly one Agent Protocol v3 proposal: ${ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS.join(', ')}.`,
      resourceResumeCarrierLine(),
      'Prefer actionBundle if the just-resolved evidence is sufficient for an edit task. If the current task is already sufficiently satisfied and no Kernel action is needed, return a taskOutcome object. If more evidence is needed, request only a different focused resource. If a concrete operation exceeds accepted scope, Session and Kernel will interrupt for user approval after proposal validation.',
      acceptedPlan ? `Accepted plan progress: planId=${acceptedPlan.planId}; completedTaskCount=${acceptedPlan.completedTaskIds.length}; remainingTaskCount=${acceptedPlan.tasks.filter((task) => !acceptedPlan.completedTaskIds.includes(task.taskId)).length}.` : '',
      cursor ? `TaskExecutionCursor: currentTaskId=${cursor.currentTaskId ?? 'none'}; completedTaskCount=${cursor.completedTaskIds.length}; lastResourcePackets=${cursor.lastResourcePacketIds.join(', ') || 'none'}.` : '',
      currentTask ? `CurrentTaskGoal: ${currentTask.goal}` : '',
      currentTask ? `CurrentTaskContext: targets=${currentTask.targets.join(', ') || 'none'}; capabilities=${currentTask.capabilities.join(', ') || 'none'}; evidenceNeeds=${currentTask.evidenceNeeds.join(', ') || 'none'}.` : '',
      `Original resourceRequest proposalId=${requestProposal.proposalId}; kind=${requestProposal.kind}.`,
      `Resolved ResourcePacket id=${packet.id}; itemCount=${packet.items.length}:`,
      fenced(clip(JSON.stringify(resourceItems, null, 2), 6_000)),
      'ActionBundle constraints: use concrete tool actions only; codeBlocks use contentLines; patch match text must come from the resolved ResourcePacket or another fresh ResourcePacket; new files may be complete writes if in accepted scope.',
      'Directory targets are planning scopes only. Do not output empty .gitkeep or placeholder writes to create directories; write concrete files and let Kernel create parent directories.',
    ].filter(Boolean).join('\n\n');
  }
}

function resourceResumeCarrierLine(): string {
  // ProviderTurnContract owns the schema details; this checkpoint only names the top-level carriers.
  return 'Use the ProviderTurnContract above as the schema authority. Carrier fields by kind: actionBundle uses userPlanMarkdown/codeBlocks/actionBundle; resourceRequest uses resourceRequest; taskOutcome uses taskOutcome; decisionRequest uses decisionRequest; diagnostic uses diagnostic. Do not add payload wrappers or explanatory prose outside the final JSON object.';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
