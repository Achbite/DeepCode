import type { LlmChatRequest } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { NativeToolCallProposal } from '../provider/providerStreamParts.js';
import type { PromptEnvelope } from './types.js';
import { ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS } from './AcceptedPlanResourceResumePromptBuilder.js';
import { RepairProviderTurnContractBuilder, type RepairProviderTurnContractInput } from './RepairProviderTurnContractBuilder.js';

export interface ProviderRepairCurrentTaskContext {
  taskId?: string;
  taskTitle?: string;
  goal?: string;
  targets: string[];
  toolIds: string[];
}

export interface ProviderRepairMessageState {
  runId: string;
  userRequest: string;
  conversationRoots: unknown[];
  resourcePackets: unknown[];
  implementationBatch?: unknown;
  acceptedContext?: Record<string, unknown>;
  currentTaskContext?: ProviderRepairCurrentTaskContext;
  completedTaskCount?: number;
}

export interface ProviderRepairTurnSummary {
  content: string;
}

export interface ProviderRepairNativeReadSignature {
  key: string;
  toolName: string;
  path: string;
  rootId?: string;
  offsetBytes?: number;
  limitBytes?: number;
}

export interface ProviderRepairNativeReadLedgerEntry {
  signature: ProviderRepairNativeReadSignature;
  packet: { id?: string };
  contentHash: string;
  repeatCount: number;
}

export class ProviderRepairMessageBuilder {

  repairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    invalidOutput: string,
    parseError: { code: string; message: string }
  ): LlmChatRequest['messages'] {
    const acceptedExecution = Boolean(state.acceptedContext && Object.keys(state.acceptedContext).length > 0) || Boolean(state.currentTaskContext);
    const actionBundleRepair = acceptedExecution || this.isActionBundleRepairError(parseError.code);
    const allowedKinds = actionBundleRepair
      ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
      : ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'];
    const repairSystemLines = [
      'You are the DeepCode Agent Protocol v4 repair step.',
      'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
      'Do not add execution facts, permissions, or tool results.',
      `Allowed proposal kinds: ${allowedKinds.join(', ')}.`,
      acceptedExecution
        ? 'An accepted task is already active. Do not output taskPlan; repair toward the current task actionBundle/resourceRequest/decisionRequest/diagnostic only.'
        : actionBundleRepair
          ? 'Repair the existing actionBundle proposal only if it remains a valid reviewable side-effect proposal; otherwise output taskPlan, resourceRequest, decisionRequest, or diagnostic as allowed.'
          : 'For initial side-effect work, output taskPlan unless acceptedTaskPlan context is already present. Do not output actionBundle in this repair call.',
      repairSchemaAuthorityLine(),
      ...(actionBundleRepair ? [actionBundleCarrierGuidanceLine()] : []),
      actionBundleRepair
        ? 'Use contentBlocks[].contentLines for source code. Do not output large contentBlocks.content strings and do not manually escape multiline source code into JSON strings.'
        : 'Execution actionBundle schema and Kernel tool args are intentionally withheld in this repair call.',
      actionBundleRepair
        ? 'For fs.write, args.contentBlockId must reference a top-level contentBlocks[].blockId for the same args.path. Directory targets are planning scopes; do not repair by creating empty .gitkeep or other placeholder files.'
        : 'Represent future work as taskPlan tasks with concrete non-root targets, canonical toolId, acceptanceCriteria, and failureCriteria. Use registered fs.* tools for workspace changes; do not use process.exec as a file-system fallback.',
      actionBundleRepair
        ? ''
        : 'Do not create standalone directory-creation tasks unless a concrete directory tool is available; parent directories may be implied by planned concrete file writes.',
      'Use only the canonical taskPlan and actionBundle schemas. Every executable action uses toolId plus typed args.',
      'Output ONLY the single JSON object - no prose, no explanation, and no markdown ``` code fences before or after it.',
      actionBundleRepair
        ? 'actionBundle.version must be exactly the string "1".'
        : '',
      actionBundleRepair
        ? 'For a side-effect actionBundle, actionBundle.validationExpectations and actionBundle.reviewExpectations are optional; Session derives routine defaults when they are omitted or empty.'
        : '',
      'Repair once from the compact context only; do not rely on omitted prompt text.',
    ].filter(Boolean);
    return [
      {
        role: 'system',
        content: repairSystemLines.join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: 'protocolRepair',
            allowedKinds,
            repairPolicy: 'sameKindOnly',
            errorLines: [`${parseError.code}: ${parseError.message}`],
          }),
          ...this.compactRepairContextLines(prompt, state),
          'Repair carrier reminder:',
          fenced(this.protocolRepairShapeReference(parseError.code, allowedKinds)),
          `Parser error code: ${parseError.code}`,
          `Parser error message: ${parseError.message}`,
          'Invalid model output, clipped:',
          fenced(clip(invalidOutput, 4_000)),
        ].join('\n\n'),
      },
    ];
  }

  actionBundleCompactionRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    reason: string,
    invalidOutput: string
  ): LlmChatRequest['messages'] {
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v4 implementation batch repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
          'If proposing executable work, return kind="actionBundle" for a coherent batch that fits the payload budget.',
          repairSchemaAuthorityLine(),
          actionBundleCarrierGuidanceLine(),
          'Use contentBlocks[].contentLines for source code.',
          'Use canonical actionBundle actions and carry source text only as contentBlocks[].contentLines.',
          'Artifact payload budget is supplied by the current Kernel StateContract. Do not estimate or declare a different Session-side limit.',
          'For new files, prefer one complete file write when it fits the payload budget. For large rewrites, split by module, file section, class, function, or script/config section. continuationExpectations may describe current-task payload or evidence-delayed work, but must not reduce the accepted plan scope or schedule later tasks.',
          'Directory targets are planning scopes only. Do not create empty .gitkeep or placeholder writes for directories; output concrete file writes and reference each file content with args.contentBlockId.',
          'If current facts are insufficient, return kind="resourceRequest" using manifestEntryId, rootId+path, or kind="search" with a non-empty query under the listed conversation roots.',
          'Do not claim execution, permissions, tests passed, or task completion.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: 'acceptedTaskExecution',
            allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
            requiredKind: 'actionBundle',
            repairPolicy: 'sameKindOnly',
            errorLines: [reason],
          }),
          ...this.compactRepairContextLines(prompt, state, { includeImplementationBatch: true }),
          `Repair reason: ${reason}`,
          'Invalid or empty model output, clipped:',
          fenced(clip(invalidOutput || '[empty response]', 4_000)),
        ].join('\n\n'),
      },
    ];
  }

  completeStageToolViolationRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    toolCall: NativeToolCallProposal,
    turn: ProviderRepairTurnSummary
  ): LlmChatRequest['messages'] {
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode accepted-plan proposal-only repair step.',
          'Complete-stage provider-native tools are disabled. Do not call tools.',
          'Return exactly one valid Agent Protocol v4 JSON object.',
          'If executable work is ready, return kind="actionBundle" within the accepted taskPlan scope.',
          'If evidence is missing, return kind="resourceRequest". If a concrete operation exceeds accepted scope, keep the corrected operation intent explicit; Session will fail closed or produce a deterministic intervention.',
          'Never claim that files were written, commands ran, permissions were granted, validation passed, or tasks completed.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: 'acceptedTaskExecution',
            allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
            repairPolicy: 'sameKindOnly',
            errorLines: [`Provider-native tool call was blocked in Complete stage: ${toolCall.name}`],
          }),
          `Blocked native tool during Complete stage: ${toolCall.name}`,
          `Tool call id: ${toolCall.callId}`,
          'Tool arguments:',
          fenced(JSON.stringify(toolCall.arguments, null, 2)),
          'Provider narration before blocked tool:',
          fenced(clip(turn.content || '[empty]', 2_000)),
          ...this.compactRepairContextLines(prompt, state, { includeAcceptedPlan: true }),
          'ActionBundle carrier reminder:',
          fenced(actionBundleCarrierGuidanceLine()),
        ].join('\n\n'),
      },
    ];
  }

  sideEffectNativeToolRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    toolCall: NativeToolCallProposal,
    turn: ProviderRepairTurnSummary,
    afterAcceptedPlan: boolean
  ): LlmChatRequest['messages'] {
    const requestedKind = afterAcceptedPlan ? 'actionBundle' : 'decisionRequest-or-taskPlan';
    const guardrail = afterAcceptedPlan
      ? 'A plan/contract has already been accepted. Return kind="actionBundle" only for the next related batch within the accepted scope. Multiple related files are allowed when all target paths stay in scope. Use workspace-relative target paths by default; absolute paths are allowed only for outside-workspace files already reviewed in the accepted contract.'
      : 'Return kind="decisionRequest" if a material engineering choice needs user selection; otherwise return kind="taskPlan" with the non-executable Plan/Check task slices. Do not return actionBundle before taskPlan acceptance.';
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v4 native-tool repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
          'Provider-native side-effect tools are disabled in Session Runtime. Do not call tools.',
          guardrail,
          'Never claim that files were written, commands ran, permissions were granted, or validation passed.',
          'If returning decisionRequest, ask one concise question with 2-3 mutually exclusive options, exactly one recommended option, impact descriptions, allowsFreeform=true, and user-visible text in the current user language.',
          'If returning taskPlan, put taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints directly on the top-level JSON object. tasks[] must be ordered reviewable engineering batches, not one task per file; each task includes canonical toolId plus concrete, non-root file or directory targets. Keep taskPlan strictly non-executable.',
          ...(afterAcceptedPlan ? [
            'If returning actionBundle after acceptedTaskPlan, put userPlanMarkdown, contentBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
            'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use currentTaskToolIds and current task targets.',
            'Use contentBlocks[].contentLines for source code in Complete-stage actionBundle only.',
          ] : []),
          'Use canonical toolId plus typed args. Carry source text only as contentBlocks[].contentLines.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: afterAcceptedPlan ? 'acceptedTaskExecution' : 'protocolRepair',
            allowedKinds: afterAcceptedPlan
              ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
              : ['decisionRequest', 'taskPlan', 'resourceRequest', 'diagnostic'],
            repairPolicy: 'sameKindOnly',
            errorLines: [`Provider-native side-effect tool call was blocked: ${toolCall.name}`],
          }),
          `Requested repair kind: ${requestedKind}`,
          `Blocked native tool: ${toolCall.name}`,
          `Tool call id: ${toolCall.callId}`,
          'Tool arguments:',
          fenced(JSON.stringify(toolCall.arguments, null, 2)),
          'Provider narration before blocked tool:',
          fenced(turn.content || '[empty]'),
          ...this.compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
        ].join('\n\n'),
      },
    ];
  }

  nativeToolDuplicateRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    turn: ProviderRepairTurnSummary,
    duplicates: Array<{ toolCall: NativeToolCallProposal; signature: ProviderRepairNativeReadSignature; entry: ProviderRepairNativeReadLedgerEntry }>,
    afterAcceptedPlan: boolean
  ): LlmChatRequest['messages'] {
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v4 duplicate native read repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
          'Do not call tools. The provider has repeatedly requested the same read-only native tool target/range after Session already returned Kernel ResourcePacket facts.',
          afterAcceptedPlan
            ? 'A plan has already been accepted. If executable work is ready, return kind="actionBundle" within the accepted plan scope.'
            : 'If enough facts are available, return kind="answer"; otherwise return kind="resourceRequest" only for a different target/range or search query that adds new evidence.',
          'Never request fs.read or fs.list for any duplicate target/range listed below. Use the existing ResourcePacket facts.',
          ...(afterAcceptedPlan ? [
            'For kind="actionBundle", put userPlanMarkdown, contentBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
            'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use currentTaskToolIds and current task targets.',
            'Use contentBlocks[].contentLines for source code.',
          ] : []),
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: afterAcceptedPlan ? 'resourceResume' : 'protocolRepair',
            allowedKinds: afterAcceptedPlan
              ? [...ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS]
              : ['answer', 'resourceRequest', 'decisionRequest', 'diagnostic'],
            repairPolicy: 'sameKindOnly',
            errorLines: ['Duplicate provider-native read request after Kernel ResourcePacket facts were already returned.'],
          }),
          'Duplicate native read targets:',
          fenced(JSON.stringify(duplicates.map((item) => ({
            callId: item.toolCall.callId,
            toolName: item.toolCall.name,
            signature: item.signature,
            packetId: item.entry.packet.id,
            contentHash: item.entry.contentHash,
            repeatCount: item.entry.repeatCount,
          })), null, 2)),
          'Provider narration before duplicate tool call:',
          fenced(turn.content || '[empty]'),
          ...this.compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
        ].join('\n\n'),
      },
    ];
  }

  resourceRequestRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    proposal: ProposalEnvelope,
    resolutionDiagnostic: string
  ): LlmChatRequest['messages'] {
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v4 resource request repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
          'Use kind="answer" if the available ResourcePacket facts are enough.',
          'Use kind="resourceRequest" only when requesting manifestEntryId, root-relative path, or kind="search" with a non-empty query under the listed conversation roots.',
          repairSchemaAuthorityLine(),
          resourceRequestCarrierGuidanceLine(),
          decisionRequestCarrierGuidanceLine(),
          'Each decisionRequest option SHOULD declare its state-machine effect via option.effect. Allowed kinds: "continueWithAction" (default, generate next actionBundle), "skipCurrentTask" (skip the current accepted-plan task), "markAcceptedIncomplete" with optional taskIds[] and reason, "replan" with reason, "finishWithAnswer", and "cancel". When the user-visible question implies "the task is already satisfied / nothing to do / stop and summarize", at least one option MUST use skipCurrentTask, markAcceptedIncomplete, or finishWithAnswer so the session can advance without forcing an empty actionBundle.',
          'Do not invent arbitrary absolute local paths. Absolute file paths are only for user-provided outside-workspace targets that require Kernel ProposalReview/permission.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: state.acceptedContext && Object.keys(state.acceptedContext).length > 0 ? 'resourceResume' : 'protocolRepair',
            allowedKinds: state.acceptedContext && Object.keys(state.acceptedContext).length > 0
              ? [...ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS]
              : ['answer', 'resourceRequest', 'decisionRequest', 'diagnostic'],
            repairPolicy: 'sameKindOnly',
            errorLines: [resolutionDiagnostic],
          }),
          ...this.compactRepairContextLines(prompt, state),
          'Invalid or unresolved resourceRequest proposal:',
          fenced(clip(JSON.stringify(proposal.payload, null, 2), 4_000)),
          'Resolution diagnostic:',
          fenced(resolutionDiagnostic),
        ].join('\n\n'),
      },
    ];
  }

  planReviewRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    proposal: ProposalEnvelope,
    report: Record<string, unknown>
  ): LlmChatRequest['messages'] {
    const acceptedExecution = Boolean(state.acceptedContext && Object.keys(state.acceptedContext).length > 0);
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v4 plan review repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
          'Repair the actionBundle so Kernel ProposalReview can evaluate concrete completion evidence.',
          'Do not claim execution, permissions, tests passed, or task completion.',
          'For kind="actionBundle", put userPlanMarkdown, contentBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
          'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use the Kernel ProposalReview report and currentTaskToolIds to correct action toolIds and targets.',
          'Kernel derives permissions and scope from normalized action args.',
          'Use contentBlocks[].contentLines for source code and canonical toolId plus typed args for actions.',
          'Do not add new toolIds or expand targets unless the Kernel report explicitly requires a repairable correction.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: acceptedExecution ? 'acceptedTaskExecution' : 'protocolRepair',
            allowedKinds: acceptedExecution
              ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
              : ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'],
            requiredKind: 'actionBundle',
            repairPolicy: 'sameKindOnly',
            errorLines: ['Kernel ProposalReview rejected the actionBundle proposal.'],
          }),
          ...this.compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
          'Original proposal summary:',
          fenced(clip(JSON.stringify({
            proposalId: proposal.proposalId,
            kind: proposal.kind,
            payloadKeys: Object.keys(objectRecord(proposal.payload) ?? {}),
          }, null, 2), 1_000)),
          'Kernel ProposalReview report:',
          fenced(clip(JSON.stringify(report, null, 2), 5_000)),
          'Repair requirement:',
          fenced('For side-effect actions, include detailed structured Markdown userPlan. It must cover summary, changes, interfaces or affected surfaces, validation or test plan, and assumptions or constraints; headings may be localized to the user language. actionBundle.validationExpectations/reviewExpectations are optional provider notes because Session derives routine defaults when omitted. Use toolId+typed args only.'),
        ].join('\n\n'),
      },
    ];
  }

  actionBundleAdmissionRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    proposal: ProposalEnvelope,
    reasons: string[]
  ): LlmChatRequest['messages'] {
    const acceptedExecution = Boolean(state.acceptedContext && Object.keys(state.acceptedContext).length > 0);
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v4 actionBundle admission repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v4".',
          'The current actionBundle failed Session protocol-shape admission before Kernel review.',
          'In accepted-task execution, use the exact toolId and typed args supplied by currentTaskActionTemplates. Do not infer or alter target type, recursion, scope, risk, or permission fields.',
          'Use canonical toolId plus typed args and contentBlocks[].contentLines.',
          'If the current Kernel authorization operation is unavailable or incompatible, return diagnostic instead of guessing a replacement operation.',
          'If current evidence is insufficient, return resourceRequest; if the user intent requires an engineering choice, return decisionRequest.',
          'Do not claim execution, permissions, tests passed, or task completion.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: acceptedExecution ? 'acceptedTaskExecution' : 'protocolRepair',
            allowedKinds: acceptedExecution
              ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic']
              : ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'],
            repairPolicy: 'sameKindOnly',
            errorLines: reasons,
          }),
          ...this.compactRepairContextLines(prompt, state),
          'Invalid proposal summary:',
          fenced(clip(JSON.stringify({
            proposalId: proposal.proposalId,
            kind: proposal.kind,
            payloadKeys: Object.keys(objectRecord(proposal.payload) ?? {}),
          }, null, 2), 1_000)),
          'Session admission reasons:',
          fenced(reasons.map((reason) => `- ${reason}`).join('\n')),
          'Repair requirement:',
          fenced('Return a corrected actionBundle that preserves the exact current Kernel authorization operation and currentTaskActionTemplates. Repair protocol structure only; do not derive permissions, risk, target type, recursion, or path scope in Session. Return resourceRequest, decisionRequest, or diagnostic when the required evidence, user choice, or exact Kernel template is unavailable.'),
        ].join('\n\n'),
      },
    ];
  }

  private compactRepairContextLines(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    options?: { includeImplementationBatch?: boolean; includeAcceptedPlan?: boolean }
  ): string[] {
    const roots = clip(JSON.stringify(state.conversationRoots, null, 2), 2_000);
    const packets = clip(JSON.stringify(state.resourcePackets.slice(-6), null, 2), 6_000);
    const acceptedExecution = Boolean(state.acceptedContext && Object.keys(state.acceptedContext).length > 0) || Boolean(state.currentTaskContext);
    const lines = [
      acceptedExecution
        ? 'Original user request source reference, not execution authority:'
        : 'Current user goal summary:',
      fenced(acceptedExecution ? clip(oneLineText(state.userRequest, 240), 240) : clip(state.userRequest, 1_200)),
      'Available conversation roots summary:',
      fenced(roots || '[]'),
      'Recent ResourcePacket summary, clipped:',
      fenced(packets || '[]'),
      'Prompt envelope size summary, content intentionally omitted from repair:',
      fenced(JSON.stringify({
        stablePrefixChars: prompt.stablePrefix.length,
        dynamicSuffixChars: prompt.dynamicSuffix.length,
      }, null, 2)),
    ];
    if (options?.includeImplementationBatch) {
      lines.push('Implementation batch context summary:', fenced(clip(JSON.stringify(state.implementationBatch, null, 2), 2_000)));
    }
    if (options?.includeAcceptedPlan) {
      lines.push('Accepted current task summary:', fenced(JSON.stringify(acceptedRepairContextSummary(state), null, 2)));
    }
    return lines;
  }

  renderRepairProviderTurnContract(
    state: ProviderRepairMessageState,
    input: {
      turnMode: RepairProviderTurnContractInput['turnMode'];
      allowedKinds: string[];
      requiredKind?: string;
      repairPolicy?: RepairProviderTurnContractInput['repairPolicy'];
      errorLines?: string[];
    }
  ): string {
    return new RepairProviderTurnContractBuilder().render({
      ...input,
      acceptedContext: state.acceptedContext,
      currentTaskContext: state.currentTaskContext,
      completedTaskCount: state.completedTaskCount ?? 0,
    });
  }

  private protocolRepairShapeReference(errorCode: string, allowedKinds: string[]): string {
    const allows = (kind: string): boolean => allowedKinds.includes(kind);
    const common = [
      repairSchemaAuthorityLine(),
      'Provider output must be one Agent Protocol v4 JSON object.',
      `Allowed proposal kinds for this repair call: ${allowedKinds.join(', ') || 'none'}.`,
      'reviewSummary is Session-generated and must not be returned by the provider.',
      allows('answer')
        ? 'Carrier: answer uses top-level answer.'
        : '',
      allows('resourceRequest')
        ? resourceRequestCarrierGuidanceLine()
        : '',
      allows('decisionRequest')
        ? decisionRequestCarrierGuidanceLine()
        : '',
      allows('taskPlan')
        ? 'For kind="taskPlan", put taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints at the top level. tasks[] must be a Session-advanced ordered queue of reviewable engineering batches, not a graph and not one task per file. Group related files or operations that should be implemented together. Each task must include canonical toolId, concrete non-root target or targets, acceptanceCriteria[], and failureCriteria[]; do not use workspace root, project root, ".", "/", or wildcard targets. Keep taskPlan strictly non-executable.'
        : '',
      allows('actionBundle')
        ? actionBundleCarrierGuidanceLine()
        : '',
      allows('actionBundle')
        ? 'contentBlocks[] uses {blockId,targetPath,language?,operation?,contentLines,allowEmptyContent?}; contentLines is the only source-code carrier.'
        : '',
      allows('actionBundle')
        ? 'fs.write actions use args={path,contentBlockId}; contentBlockId must match the blockId of the contentBlock carrying that exact file content.'
        : '',
      allows('actionBundle')
        ? 'Directory targets such as src/ are planning scopes only. Do not create empty .gitkeep or placeholder files unless the user explicitly requested that concrete file. For new files, write the concrete file and let Kernel create parent directories.'
        : '',
      allows('actionBundle')
        ? 'Empty content is valid only for operation="createEmpty" on an explicit empty file, or for patch/replace/insert operations when the protocol explicitly permits it.'
        : '',
      'Use only canonical taskPlan tasks and actionBundle actions with toolId plus typed args.',
    ].filter(Boolean);
    void errorCode;
    if (allows('taskPlan')) {
      common.push(
        `Minimal taskPlan skeleton:\n${this.minimalTaskPlanRepairSkeleton()}`
      );
    }
    return common.join('\n');
  }

  private isActionBundleRepairError(errorCode: string): boolean {
    return errorCode === 'invalid_action_bundle'
      || errorCode === 'invalid_action_bundle_expectation'
      || errorCode === 'invalid_action_bundle_continuation';
  }

  private minimalTaskPlanRepairSkeleton(): string {
    return JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v4',
      kind: 'taskPlan',
      taskPlan: {
        version: '1',
        id: 'task-plan',
        title: 'Reviewable task plan',
        summary: 'Plan the requested work as an ordered queue.',
        tasks: [
          {
            taskId: 'task-1',
            title: 'Prepare concrete workspace change',
            toolId: 'fs.create',
            target: ['relative/file.ext'],
            acceptanceCriteria: ['Reviewable completion criterion for this task.'],
            failureCriteria: ['Stop or replan condition for this task.'],
          },
        ],
        risks: [],
        reviewCheckpoints: [],
      },
    }, null, 2);
  }
}

// Repair side calls must not duplicate full protocol skeletons outside ProviderTurnContract.
function repairSchemaAuthorityLine(): string {
  return 'Use the ProviderTurnContract above as the schema authority. Do not add payload wrappers or explanatory prose outside the final JSON object.';
}

function actionBundleCarrierGuidanceLine(): string {
  return 'Carrier fields by kind: actionBundle uses top-level userPlanMarkdown, contentBlocks, and actionBundle. validationExpectations/reviewExpectations are optional provider notes; Session derives routine defaults when omitted.';
}

function resourceRequestCarrierGuidanceLine(): string {
  return 'Carrier fields by kind: resourceRequest uses top-level resourceRequest. Use items[] for manifestEntryId, rootId+path, or search query under listed conversation roots.';
}

function decisionRequestCarrierGuidanceLine(): string {
  return 'Carrier fields by kind: decisionRequest uses top-level decisionRequest with a non-empty question, 2-3 options, and allowsFreeform=true when user input is required.';
}

function acceptedRepairContextSummary(state: ProviderRepairMessageState): Record<string, unknown> {
  const acceptedContext = state.acceptedContext ?? {};
  const currentTask = objectRecord(acceptedContext.currentTask);
  const currentTaskTargets = state.currentTaskContext?.targets.length
    ? state.currentTaskContext.targets
    : stringArrayValue(currentTask?.targets ?? currentTask?.target);
  const currentTaskToolIds = state.currentTaskContext?.toolIds.length
    ? state.currentTaskContext.toolIds
    : stringArrayValue(currentTask?.toolIds ?? currentTask?.capability);
  return {
    authority: 'confirmed current accepted task',
    originalUserRequest: 'source reference only',
    currentTask: {
      taskId: state.currentTaskContext?.taskId ?? stringValue(currentTask?.taskId),
      title: state.currentTaskContext?.taskTitle ?? stringValue(currentTask?.title),
      objective: state.currentTaskContext?.goal ?? stringValue(currentTask?.objective),
      targets: currentTaskTargets,
      toolIds: currentTaskToolIds,
    },
    completedTaskCount: state.completedTaskCount ?? 0,
    currentTaskOperations: Array.isArray(acceptedContext.currentTaskOperations)
      ? acceptedContext.currentTaskOperations.length
      : 0,
    currentTaskActionTemplates: Array.isArray(acceptedContext.currentTaskActionTemplates)
      ? acceptedContext.currentTaskActionTemplates.length
      : 0,
  };
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
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  return typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : [];
}

function oneLineText(value: string, maxChars: number): string {
  return clip(value.replace(/\s+/g, ' ').trim(), maxChars);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
