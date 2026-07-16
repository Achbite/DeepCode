import type { ProposalEnvelope } from '../../protocol/types.js';
import type { KernelArtifactEditMatch } from '@deepcode/protocol';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import { IntentSlotRegistry, type IntentSlot } from './intentSlot.js';

export interface TaskArtifactDirective {
  readonly summary: string;
  readonly narration?: string;
  readonly artifacts: readonly TaskArtifactInput[];
}

export interface TaskArtifactInput {
  readonly slotId: string;
  readonly contentLines?: readonly string[];
  readonly editMatch?: KernelArtifactEditMatch;
  readonly replacementLines?: readonly string[];
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export class OperationIntentCompiler {
  constructor(private readonly slots = new IntentSlotRegistry()) {}

  compileArtifacts(input: {
    sessionId: string;
    runId: string;
    callId: string;
    acceptedPlan: AcceptedTaskPlanContext | undefined;
    directive: TaskArtifactDirective;
  }): ProposalEnvelope {
    const slots = this.slots.currentTaskSlots(input.acceptedPlan);
    const currentTaskId = slots[0]?.taskId;
    if (!currentTaskId) throw new Error('Task artifact directive has no active accepted task.');
    const slotIndex = new Map(slots.map((slot) => [slot.slotId, slot]));
    const contentBlocks: Record<string, unknown>[] = [];
    const actions: Record<string, unknown>[] = [];
    for (const artifact of input.directive.artifacts) {
      const slot = slotIndex.get(artifact.slotId);
      if (!slot) throw new Error(`Task artifact directive references unknown IntentSlot ${artifact.slotId}.`);
      this.compileSlot(slot, artifact, contentBlocks, actions);
    }
    if (!actions.length) throw new Error('Task artifact directive did not compile any current-task operations.');
    return proposal(input, input.directive.narration, {
      userPlan: input.directive.summary,
      contentBlocks,
      actionBundle: {
        version: '1',
        id: `${input.callId}-action-bundle`,
        goal: input.directive.summary,
        actions,
        validationExpectations: [{ id: 'kernel-facts', description: 'Kernel facts record the current task operation results.' }],
        reviewExpectations: [{ id: 'review-current-task', description: 'Review the actual current task targets and Kernel execution facts.' }],
      },
    });
  }

  compileDeterministicDelete(input: {
    sessionId: string;
    runId: string;
    acceptedPlan: AcceptedTaskPlanContext | undefined;
  }): ProposalEnvelope | undefined {
    const slots = this.slots.deterministicDeleteSlots(input.acceptedPlan);
    if (!slots.length) return undefined;
    const callId = `deterministic-${slots[0].taskId}`;
    const actions = slots.map((slot, index) => {
      const actionId = `${callId}-${index + 1}`;
      return {
        ...fileActionContract(actionId, 'fs.delete'),
        args: deleteArgs(slot),
        description: `Apply the confirmed delete operation for IntentSlot ${slot.slotId}.`,
      };
    });
    return proposal({ ...input, callId }, undefined, {
      userPlan: 'Apply the exact delete operations already confirmed for the current task.',
      contentBlocks: [],
      actionBundle: {
        version: '1',
        id: `${callId}-action-bundle`,
        goal: 'Apply confirmed current-task delete operations.',
        actions,
        validationExpectations: [{ id: 'kernel-delete-facts', description: 'Kernel facts record every confirmed delete target.' }],
        reviewExpectations: [{ id: 'review-delete-targets', description: 'Review the actual deleted paths from Kernel facts.' }],
      },
    });
  }

  private compileSlot(
    slot: IntentSlot,
    artifact: TaskArtifactInput,
    contentBlocks: Record<string, unknown>[],
    actions: Record<string, unknown>[]
  ): void {
    const actionId = `action-${slot.slotId}`;
    if (slot.operation === 'createFile' || slot.operation === 'replaceFile') {
      const contentLines = cleanLines(artifact.contentLines);
      if (!contentLines) throw new Error(`IntentSlot ${slot.slotId} requires full artifact content.`);
      const blockId = `block-${slot.slotId}`;
      contentBlocks.push({
        blockId,
        targetPath: slot.targetRef,
        operation: slot.operation === 'createFile' ? 'create' : 'overwrite',
        contentLines,
      });
      const toolId = slot.operation === 'createFile' ? 'fs.create' : 'fs.write';
      actions.push({
        ...fileActionContract(actionId, toolId),
        args: { ...slot.fixedArgs, path: slot.targetRef, contentBlockId: blockId },
        description: `Apply generated content for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    if (slot.operation === 'patchFile') {
      const replacementLines = cleanLines(artifact.replacementLines);
      if (!replacementLines || !artifact.editMatch) {
        throw new Error(`IntentSlot ${slot.slotId} requires editMatch and replacement content.`);
      }
      const blockId = `block-${slot.slotId}`;
      contentBlocks.push({
        blockId,
        targetPath: slot.targetRef,
        operation: 'replaceBlock',
        contentLines: replacementLines,
      });
      actions.push({
        ...fileActionContract(actionId, 'fs.edit'),
        args: {
          ...slot.fixedArgs,
          path: slot.targetRef,
          replacementBlockId: blockId,
          patchSpec: { match: editMatchToKernel(artifact.editMatch) },
        },
        description: `Apply the exact patch for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    if (slot.operation === 'deletePath') {
      actions.push({
        ...fileActionContract(actionId, 'fs.delete'),
        args: deleteArgs(slot),
        description: `Apply the confirmed delete for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    if (slot.operation === 'runProcess') {
      const argv = cleanLines(artifact.argv);
      if (!argv) throw new Error(`IntentSlot ${slot.slotId} requires argv.`);
      actions.push({
        actionId,
        toolId: 'process.exec',
        args: {
          argv,
          cwd: stringValue(artifact.cwd) ?? '.',
          timeoutMs: positiveInteger(artifact.timeoutMs) ?? 120000,
        },
        description: `Run the confirmed process for IntentSlot ${slot.slotId}.`,
        dependsOn: [],
      });
      return;
    }
    throw new Error(`IntentSlot ${slot.slotId} operation ${slot.operation} is not artifact-compilable.`);
  }
}

function deleteArgs(slot: IntentSlot): Record<string, unknown> {
  if (!slot.targetResourceKind) {
    throw new Error(
      `accepted_plan_authorization_contract_incompatible: delete IntentSlot ${slot.slotId} has no Kernel target kind.`
    );
  }
  return {
    ...slot.fixedArgs,
    path: slot.targetRef,
    targetKind: slot.targetResourceKind,
    recursive: slot.recursive === true,
  };
}

function editMatchToKernel(editMatch: KernelArtifactEditMatch): Record<string, unknown> {
  if (editMatch.kind === 'exactBlock') {
    return { kind: editMatch.kind, text: editMatch.targetLines.join('\n') };
  }
  if (editMatch.kind === 'contextBlock') {
    return {
      kind: editMatch.kind,
      before: editMatch.beforeLines.length ? `${editMatch.beforeLines.join('\n')}\n` : '',
      target: editMatch.targetLines.join('\n'),
      after: editMatch.afterLines.length ? `\n${editMatch.afterLines.join('\n')}` : '',
    };
  }
  return {
    kind: editMatch.kind,
    startLine: editMatch.startLine,
    endLine: editMatch.endLine,
    ...(editMatch.expectedFileHash ? { expectedFileHash: editMatch.expectedFileHash } : {}),
    ...(editMatch.expectedBeforeText || editMatch.expectedBeforeLines
      ? { expectedBeforeBlock: editMatch.expectedBeforeText ?? editMatch.expectedBeforeLines?.join('\n') }
      : {}),
  };
}

function proposal(
  input: { sessionId: string; runId: string; callId: string },
  narration: string | undefined,
  payload: unknown
): ProposalEnvelope {
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
    proposalId: `proposal-${input.callId}`,
    runId: input.runId,
    sessionId: input.sessionId,
    source: 'llm',
    kind: 'actionBundle',
    narration,
    payload,
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
}

function cleanLines(value: readonly string[] | undefined): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string')) return undefined;
  return [...value];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function fileActionContract(actionId: string, toolId: string): Record<string, unknown> {
  return {
    actionId,
    toolId,
    dependsOn: [],
  };
}
