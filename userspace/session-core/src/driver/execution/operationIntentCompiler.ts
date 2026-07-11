import type { ProposalEnvelope } from '../../protocol/types.js';
import type { AcceptedImplementationPlanContext } from '../../accepted-plan/types.js';
import { IntentSlotRegistry, type IntentSlot } from './intentSlot.js';

export interface TaskArtifactDirective {
  readonly summary: string;
  readonly narration?: string;
  readonly artifacts: readonly TaskArtifactInput[];
}

export interface TaskArtifactInput {
  readonly slotId: string;
  readonly contentLines?: readonly string[];
  readonly matchText?: string;
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
    acceptedPlan: AcceptedImplementationPlanContext | undefined;
    directive: TaskArtifactDirective;
  }): ProposalEnvelope {
    const slots = this.slots.currentTaskSlots(input.acceptedPlan);
    const currentTaskId = slots[0]?.taskId;
    if (!currentTaskId) throw new Error('Task artifact directive has no active accepted task.');
    const slotIndex = new Map(slots.map((slot) => [slot.slotId, slot]));
    const codeBlocks: Record<string, unknown>[] = [];
    const actions: Record<string, unknown>[] = [];
    for (const artifact of input.directive.artifacts) {
      const slot = slotIndex.get(artifact.slotId);
      if (!slot) throw new Error(`Task artifact directive references unknown IntentSlot ${artifact.slotId}.`);
      this.compileSlot(slot, artifact, codeBlocks, actions);
    }
    if (!actions.length) throw new Error('Task artifact directive did not compile any current-task operations.');
    return proposal(input, input.directive.narration, {
      userPlan: input.directive.summary,
      codeBlocks,
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
    acceptedPlan: AcceptedImplementationPlanContext | undefined;
  }): ProposalEnvelope | undefined {
    const slots = this.slots.deterministicDeleteSlots(input.acceptedPlan);
    if (!slots.length) return undefined;
    const callId = `deterministic-${slots[0].taskId}`;
    const actions = slots.map((slot, index) => {
      const actionId = `${callId}-${index + 1}`;
      const recursive = slot.targetResourceKind === 'directory' || slot.recursive === true;
      return {
        ...fileActionContract(actionId, 'fs.delete', slot.targetRef),
        targetKind: slot.targetResourceKind ?? 'file',
        targetResourceKind: slot.targetResourceKind ?? 'file',
        recursive,
        args: {
          path: slot.targetRef,
          targetKind: slot.targetResourceKind ?? 'file',
          recursive,
        },
        description: `Apply the confirmed delete operation for IntentSlot ${slot.slotId}.`,
      };
    });
    return proposal({ ...input, callId }, undefined, {
      userPlan: 'Apply the exact delete operations already confirmed for the current task.',
      codeBlocks: [],
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
    codeBlocks: Record<string, unknown>[],
    actions: Record<string, unknown>[]
  ): void {
    const actionId = `action-${slot.slotId}`;
    if (slot.operation === 'createFile' || slot.operation === 'replaceFile') {
      const contentLines = cleanLines(artifact.contentLines);
      if (!contentLines) throw new Error(`IntentSlot ${slot.slotId} requires full artifact content.`);
      const blockId = `block-${slot.slotId}`;
      codeBlocks.push({
        blockId,
        targetPath: slot.targetRef,
        operation: slot.operation === 'createFile' ? 'create' : 'overwrite',
        content: contentLines.join('\n'),
        contentLines,
      });
      actions.push({
        ...fileActionContract(actionId, 'fs.write', slot.targetRef),
        sourceBlockId: blockId,
        args: { path: slot.targetRef, sourceBlockId: blockId },
        description: `Apply generated content for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    if (slot.operation === 'patchFile') {
      const replacementLines = cleanLines(artifact.replacementLines);
      const matchText = stringValue(artifact.matchText);
      if (!replacementLines || !matchText) throw new Error(`IntentSlot ${slot.slotId} requires exact match text and replacement content.`);
      const blockId = `block-${slot.slotId}`;
      codeBlocks.push({
        blockId,
        targetPath: slot.targetRef,
        operation: 'replaceBlock',
        content: replacementLines.join('\n'),
        contentLines: replacementLines,
      });
      actions.push({
        ...fileActionContract(actionId, 'fs.patch', slot.targetRef),
        replacementBlockId: blockId,
        patchSpec: { match: { kind: 'exactBlock', text: matchText } },
        args: {
          path: slot.targetRef,
          replacementBlockId: blockId,
          patchSpec: { match: { kind: 'exactBlock', text: matchText } },
        },
        description: `Apply the exact patch for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    if (slot.operation === 'deletePath') {
      const recursive = slot.targetResourceKind === 'directory' || slot.recursive === true;
      actions.push({
        ...fileActionContract(actionId, 'fs.delete', slot.targetRef),
        targetKind: slot.targetResourceKind ?? 'file',
        targetResourceKind: slot.targetResourceKind ?? 'file',
        recursive,
        args: {
          path: slot.targetRef,
          targetKind: slot.targetResourceKind ?? 'file',
          recursive,
        },
        description: `Apply the confirmed delete for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    if (slot.operation === 'runProcess') {
      const argv = cleanLines(artifact.argv);
      if (!argv) throw new Error(`IntentSlot ${slot.slotId} requires argv.`);
      actions.push({
        id: actionId,
        title: `Run process for ${slot.slotId}`,
        actionId,
        toolId: 'process.exec',
        capability: 'process.exec',
        resourceScope: [],
        canParallelize: false,
        conflictKeys: [`process:${slot.slotId}`],
        args: {
          argv,
          cwd: stringValue(artifact.cwd) ?? '.',
          timeoutMs: positiveInteger(artifact.timeoutMs) ?? 120000,
        },
        description: `Run the confirmed process for IntentSlot ${slot.slotId}.`,
      });
      return;
    }
    throw new Error(`IntentSlot ${slot.slotId} operation ${slot.operation} is not artifact-compilable.`);
  }
}

function proposal(
  input: { sessionId: string; runId: string; callId: string },
  narration: string | undefined,
  payload: unknown
): ProposalEnvelope {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
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

function fileActionContract(actionId: string, capability: string, targetPath: string): Record<string, unknown> {
  return {
    id: actionId,
    title: `${capability} ${targetPath}`,
    actionId,
    toolId: capability,
    capability,
    targetRef: {
      kind: isAbsolutePath(targetPath) ? 'absolutePath' : 'workspaceRelative',
      path: targetPath,
    },
    targetPath,
    resourceScope: [targetPath],
    canParallelize: false,
    conflictKeys: [`path:${targetPath}`],
  };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}
