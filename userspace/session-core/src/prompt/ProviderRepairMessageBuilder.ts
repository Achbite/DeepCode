import type { LlmChatRequest } from '@deepcode/protocol';
import { actionBundleProtocolShapeLines, resourceRequestProtocolShapeLine } from '../protocol/protocolContract.js';
import type { ProposalEnvelope } from '../protocol/types.js';
import type { NativeToolCallProposal } from '../provider/providerStreamParts.js';
import type { PromptEnvelope } from './types.js';
import { ACCEPTED_PLAN_RESOURCE_RESUME_ALLOWED_KINDS } from './AcceptedPlanResourceResumePromptBuilder.js';
import { RepairProviderTurnContractBuilder, type RepairProviderTurnContractInput } from './RepairProviderTurnContractBuilder.js';

const DEFAULT_MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 384 * 1024;

export interface ProviderRepairCurrentTaskContext {
  taskId?: string;
  taskTitle?: string;
  goal?: string;
  targets: string[];
  capabilities: string[];
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
  constructor(
    private readonly maxActionBundleTotalCodeBytes = DEFAULT_MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES
  ) {}

  repairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    invalidOutput: string,
    parseError: { code: string; message: string }
  ): LlmChatRequest['messages'] {
    const acceptedExecution = Boolean(state.acceptedContext && Object.keys(state.acceptedContext).length > 0) || Boolean(state.currentTaskContext);
    const actionBundleRepair = acceptedExecution || this.isActionBundleRepairError(parseError.code);
    const allowedKinds = actionBundleRepair
      ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic']
      : ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'];
    const repairSystemLines = [
      'You are the DeepCode Agent Protocol v3 repair step.',
      'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
      'Do not add execution facts, permissions, or tool results.',
      `Allowed proposal kinds: ${allowedKinds.join(', ')}.`,
      acceptedExecution
        ? 'An accepted task is already active. Do not output taskPlan or implementationPlan; repair toward the current task actionBundle/resourceRequest/decisionRequest/taskOutcome/diagnostic only.'
        : actionBundleRepair
          ? 'Repair the existing actionBundle proposal only if it remains a valid reviewable side-effect proposal; otherwise output taskPlan, resourceRequest, decisionRequest, or diagnostic as allowed.'
          : 'For initial side-effect work, output taskPlan unless acceptedTaskPlan context is already present. Do not output actionBundle in this repair call.',
      ...(actionBundleRepair ? actionBundleProtocolShapeLines() : []),
      actionBundleRepair
        ? 'Use codeBlocks[].contentLines for source code. Do not output large codeBlocks.content strings and do not manually escape multiline source code into JSON strings.'
        : 'Execution actionBundle schema and Kernel tool args are intentionally withheld in this repair call.',
      actionBundleRepair
        ? 'For fs.write, args.sourceBlockId must reference a top-level codeBlocks[].blockId for the same args.path. Directory targets are planning scopes; do not repair by creating empty .gitkeep or other placeholder files.'
        : 'Represent future work as taskPlan tasks with concrete non-root targets, capability, acceptanceCriteria, and failureCriteria. Use fs.write/fs.patch/fs.delete for workspace file-system changes; do not use process.exec for mkdir/rm/cp/sed/cat-redirection or other workspace file mutations.',
      actionBundleRepair
        ? ''
        : 'Do not create standalone directory-creation tasks unless a concrete directory tool is available; parent directories may be implied by planned concrete file writes.',
      'Do not output legacy implementationPlan, commandBlocks, permissionLabels, accessScopes, resourceScope, or payload wrapper fields. capability is allowed only as taskPlan.tasks[].capability; actionBundle actions must use toolId and must not output capability fields.',
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
          'Protocol field quick reference:',
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
          'You are the DeepCode Agent Protocol v3 implementation batch repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'If proposing executable work, return kind="actionBundle" for a coherent batch that fits the payload budget.',
          'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. validationExpectations[] and reviewExpectations[] are optional provider notes; Session derives routine defaults when they are omitted.',
          ...actionBundleProtocolShapeLines(),
          'Use codeBlocks[].contentLines for source code.',
          'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
          `Payload budget: at most ${this.maxActionBundleTotalCodeBytes} bytes total joined contentLines. File count, task count, and codeBlock count are not permission boundaries.`,
          'For new files, prefer one complete file write when it fits the payload budget. For large rewrites, split by module, file section, class, function, or script/config section. continuationExpectations may describe current-task payload or evidence-delayed work, but must not reduce the accepted plan scope or schedule later tasks.',
          'Directory targets are planning scopes only. Do not create empty .gitkeep or placeholder writes for directories; output concrete file writes and reference each file content with args.sourceBlockId.',
          'If current facts are insufficient, return kind="resourceRequest" using manifestEntryId, rootId+path, or kind="search" with a non-empty query under the listed conversation roots.',
          'Do not claim execution, permissions, tests passed, or task completion.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: 'acceptedTaskExecution',
            allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic'],
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
          'Return exactly one valid Agent Protocol v3 JSON object.',
          'If executable work is ready, return kind="actionBundle" within the accepted taskPlan scope.',
          'If evidence is missing, return kind="resourceRequest". If the accepted scope is insufficient, return kind="decisionRequest" or diagnostic.',
          'Never claim that files were written, commands ran, permissions were granted, validation passed, or tasks completed.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: 'acceptedTaskExecution',
            allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic'],
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
          'Minimum actionBundle skeleton:',
          fenced(this.minimalActionBundleRepairSkeleton()),
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
          'You are the DeepCode Agent Protocol v3 native-tool repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'Provider-native side-effect tools are disabled in Session Runtime. Do not call tools.',
          guardrail,
          'Never claim that files were written, commands ran, permissions were granted, or validation passed.',
          'If returning decisionRequest, ask one concise question with 2-3 mutually exclusive options, exactly one recommended option, impact descriptions, allowsFreeform=true, and user-visible text in the current user language.',
          'If returning taskPlan, put taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints directly on the top-level JSON object. tasks[] must be ordered by practical development sequence and each task must include capability plus concrete, non-root file or directory targets. Deprecated graph fields may be parsed for telemetry but are not required. taskPlan must not include source code, codeBlocks, actionBundle, commandBlocks, patches, or executable tool calls.',
          ...(afterAcceptedPlan ? [
            'If returning actionBundle after acceptedTaskPlan, put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
            'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use currentTaskCapabilities and current task targets.',
            'Use codeBlocks[].contentLines for source code in Complete-stage actionBundle only.',
          ] : []),
          'Do not output permissionLabels, accessScopes, resourceScope, commandBlocks, legacy implementationPlan, or large/multiline codeBlocks.content strings. capability is allowed only as taskPlan.tasks[].capability; actionBundle actions must use toolId and must not output capability fields.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: afterAcceptedPlan ? 'acceptedTaskExecution' : 'protocolRepair',
            allowedKinds: afterAcceptedPlan
              ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic']
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
          'You are the DeepCode Agent Protocol v3 duplicate native read repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'Do not call tools. The provider has repeatedly requested the same read-only native tool target/range after Session already returned Kernel ResourcePacket facts.',
          afterAcceptedPlan
            ? 'A plan has already been accepted. If executable work is ready, return kind="actionBundle" within the accepted plan scope.'
            : 'If enough facts are available, return kind="answer"; otherwise return kind="resourceRequest" only for a different target/range or search query that adds new evidence.',
          'Never request fs.read or fs.list for any duplicate target/range listed below. Use the existing ResourcePacket facts.',
          ...(afterAcceptedPlan ? [
            'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
            'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use currentTaskCapabilities and current task targets.',
            'Use codeBlocks[].contentLines for source code.',
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
          'You are the DeepCode Agent Protocol v3 resource request repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'Use kind="answer" if the available ResourcePacket facts are enough.',
          'Use kind="resourceRequest" only when requesting manifestEntryId, root-relative path, or kind="search" with a non-empty query under the listed conversation roots.',
          resourceRequestProtocolShapeLine(),
          'Use kind="decisionRequest" only when user input is required; minimal shape is {"schemaVersion":"deepcode.agent.protocol.v3","kind":"decisionRequest","decisionRequest":{"id":"decision-1","question":"...","options":[{"id":"option-1","label":"...","description":"...","effect":{"kind":"continueWithAction"}},{"id":"option-2","label":"...","description":"...","effect":{"kind":"continueWithAction"}}],"allowsFreeform":true}}.',
          'Each decisionRequest option SHOULD declare its state-machine effect via option.effect. Allowed kinds: "continueWithAction" (default, generate next actionBundle), "skipCurrentTask" (skip the current accepted-plan task), "markAcceptedIncomplete" with optional taskIds[] and reason, "replan" with reason, "finishWithAnswer", and "cancel". When the user-visible question implies "the task is already satisfied / nothing to do / stop and summarize", at least one option MUST use skipCurrentTask, markAcceptedIncomplete, or finishWithAnswer so the session can advance without forcing an empty actionBundle.',
          'Do not invent arbitrary absolute local paths. Absolute file paths are only for user-provided outside-workspace targets that require Kernel PlanReview/permission.',
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
          'You are the DeepCode Agent Protocol v3 plan review repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'Repair the actionBundle so Kernel PlanReview can evaluate concrete completion evidence.',
          'Do not claim execution, permissions, tests passed, or task completion.',
          'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
          'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use the Kernel PlanReview report and currentTaskCapabilities to correct action toolIds and targets.',
          'Kernel derives permissions and scope from normalized action args.',
          'Use codeBlocks[].contentLines for source code. Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
          'Do not add new toolIds or expand targets unless the Kernel report explicitly requires a repairable correction.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: acceptedExecution ? 'acceptedTaskExecution' : 'protocolRepair',
            allowedKinds: acceptedExecution
              ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic']
              : ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'],
            requiredKind: 'actionBundle',
            repairPolicy: 'sameKindOnly',
            errorLines: ['Kernel PlanReview rejected the actionBundle proposal.'],
          }),
          ...this.compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
          'Original proposal summary:',
          fenced(clip(JSON.stringify({
            proposalId: proposal.proposalId,
            kind: proposal.kind,
            payloadKeys: Object.keys(objectRecord(proposal.payload) ?? {}),
          }, null, 2), 1_000)),
          'Kernel PlanReview report:',
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
          'You are the DeepCode Agent Protocol v3 actionBundle admission repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'The current actionBundle is not allowed to become a confirmable plan card because Session detected delete targets that are not concrete enough for Kernel review.',
          'fs.delete must use toolId="fs.delete" with args.path as a concrete target. Workspace targets should use relative paths; user-confirmed outside targets may use absolute paths.',
          'Directory delete actions are allowed only when the provider explicitly requests a concrete directory target with args.targetKind="directory" and args.recursive=true so Kernel PlanReview can show that exact sensitive operation on the plan card.',
          'Do not output wildcard cleanup, workspace root cleanup, empty target cleanup, or fs.write disguised as delete. If the user intent mentions clearing a directory but you cannot identify the exact directory target, return resourceRequest/decisionRequest instead of guessing.',
          'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
          'If current evidence is insufficient to enumerate concrete files, return kind="resourceRequest" for a directoryTree/file/search read instead of guessing.',
          'If the deletion scope is ambiguous or needs a user choice, return kind="decisionRequest".',
          'Do not claim execution, permissions, tests passed, or task completion.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: acceptedExecution ? 'acceptedTaskExecution' : 'protocolRepair',
            allowedKinds: acceptedExecution
              ? ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic']
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
          fenced('Return a corrected actionBundle with concrete file targets or explicit directory targets shaped {actionId:"delete-dir",toolId:"fs.delete",args:{path:"relative/dir",targetKind:"directory",recursive:true},description:"..."}. Return resourceRequest/decisionRequest if evidence or user confirmation is required. Do not return workspace root, wildcard, empty target, or ambiguous directory cleanup.'),
        ].join('\n\n'),
      },
    ];
  }

  acceptedPlanScopeRepairMessages(
    prompt: PromptEnvelope,
    state: ProviderRepairMessageState,
    proposal: ProposalEnvelope,
    validationReasons: string[]
  ): LlmChatRequest['messages'] {
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode Agent Protocol v3 accepted-plan scope repair step.',
          'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
          'A user has already accepted an execution contract. Repair the current batch so it stays inside the accepted task targets and tool scope.',
          'If executable work is still valid, return kind="actionBundle" with one related implementation batch. Multiple related files are allowed when all targets are inside the accepted plan.',
          'Before the final JSON proposal, stream visible edit drafts with <deepcode-part>{...}</deepcode-part> frames when generating long codeBlocks/actionBundles. Final workspace writes still come only from the complete actionBundle JSON.',
          'All user-visible natural language in narration, userPlanMarkdown, validation descriptions, and review guidance must follow the current user input language.',
          'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object.',
          'For actionBundle repair, use current task action templates in ProviderTurnContract when present; otherwise use currentTaskCapabilities and current task targets.',
          resourceRequestProtocolShapeLine(),
          'Use codeBlocks[].contentLines for source code.',
          'Do not output legacy implementationPlan, commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large/multiline codeBlocks.content strings.',
          'Accepted-plan execution batches should not request workspace root, ".", module root, wildcard, or traversal scope. The accepted Kernel contract is already the authorization source; list concrete args.path/codeBlock.targetPath instead.',
          'If a patch needs current file evidence, return kind="resourceRequest" with kind="search" or a focused file/range read under the conversation roots; Session will resolve it and resume the accepted plan.',
          'Patch actions must use patchSpec.match.kind="exactBlock" and patchSpec.match.text copied from current ResourcePacket fileText/searchResults evidence.',
          'If the accepted contract is missing a required exact file/folder target, tool, or material technical choice, return kind="decisionRequest" instead of expanding the batch.',
          'For kind="decisionRequest", include decisionRequest.question as a non-empty string, plus decisionRequest.options with 2-3 options and allowsFreeform=true.',
          'For decisionRequest options that continue the same accepted task, include option.effect. Use effect.kind="expandCurrentTaskScope" with taskId, targetPath, targetResourceKind="file"|"directory", recursive=true when asking the user to approve a concrete folder/file expansion. Use effect.kind="continueCurrentTask" only when no scope expansion is needed. Use effect.kind="replan" only when the user must revise the accepted plan.',
          'Do not claim execution, permissions, tests passed, or task completion.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          this.renderRepairProviderTurnContract(state, {
            turnMode: 'scopeIntervention',
            allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'taskOutcome', 'diagnostic'],
            repairPolicy: 'deterministicIntervention',
            errorLines: validationReasons,
          }),
          ...this.compactRepairContextLines(prompt, state, { includeImplementationBatch: true, includeAcceptedPlan: true }),
          'Accepted task context:',
          fenced(clip(JSON.stringify(state.acceptedContext ?? {}, null, 2), 4_000)),
          'Invalid proposal summary:',
          fenced(clip(JSON.stringify({
            proposalId: proposal.proposalId,
            kind: proposal.kind,
            outputLanguage: stringValue((proposal as unknown as Record<string, unknown>).outputLanguage),
            payloadKeys: Object.keys(objectRecord(proposal.payload) ?? {}),
          }, null, 2), 1_000)),
          'Session validation reasons:',
          fenced(validationReasons.map((reason) => `- ${reason}`).join('\n')),
          'Repair requirement:',
          fenced('Return a corrected actionBundle within the accepted current-task scope. Set outputLanguage from the current user language. Prefer currentTaskActionTemplates from the accepted task context when present. Minimal patch shape: {"schemaVersion":"deepcode.agent.protocol.v3","kind":"actionBundle","outputLanguage":"<current-user-language>","userPlanMarkdown":"# Plan\\n\\n## Summary\\n...","codeBlocks":[{"blockId":"block-1","targetPath":"relative/file.ext","contentLines":["replacement line"]}],"actionBundle":{"version":"1","id":"batch-id","goal":"...","actions":[{"actionId":"patch-file","toolId":"fs.patch","args":{"path":"relative/file.ext","replacementBlockId":"block-1","patchSpec":{"match":{"kind":"exactBlock","text":"..."}}},"description":"..."}]}}. DecisionRequest minimal shape: {"schemaVersion":"deepcode.agent.protocol.v3","kind":"decisionRequest","outputLanguage":"<current-user-language>","decisionRequest":{"version":"1","id":"scope-choice","question":"...","options":[{"id":"continue-current-task","label":"...","description":"...","recommended":true,"effect":{"kind":"continueCurrentTask"}},{"id":"revise-plan","label":"...","description":"...","effect":{"kind":"replan","reason":"revise accepted plan scope"}}],"allowsFreeform":true}}. Do not add accessScopes/resourceScope/capability/commandBlocks/payload wrapper. If current patch evidence is missing, return resourceRequest search/read first. Return decisionRequest only if scope expansion is truly required, and include option.effect so Session can resume the same task without re-planning.'),
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
    const lines = [
      'Current user goal summary:',
      fenced(clip(state.userRequest, 1_200)),
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
      lines.push('Accepted plan context summary:', fenced(clip(JSON.stringify(state.acceptedContext ?? {}, null, 2), 3_000)));
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
      'Provider output must be one Agent Protocol v3 JSON object.',
      `Allowed proposal kinds for this repair call: ${allowedKinds.join(', ') || 'none'}.`,
      'reviewSummary is Session-generated and must not be returned by the provider.',
      allows('answer')
        ? 'For kind="answer", put answer:{format:"markdown",content:"..."} on the top-level JSON object.'
        : '',
      allows('resourceRequest')
        ? resourceRequestProtocolShapeLine()
        : '',
      allows('decisionRequest')
        ? 'For kind="decisionRequest", put decisionRequest:{id,question,reason?,summary?,options:[{id,label,description,recommended?}],allowsFreeform?} on the top-level JSON object. Do not return bare reason/options without decisionRequest.'
        : '',
      allows('taskPlan')
        ? 'For kind="taskPlan", put taskPlan.version/id/title/summary/tasks/risks/reviewCheckpoints at the top level. tasks[] must be a Session-advanced ordered engineering queue, not a graph. Each task must include capability, concrete non-root target or targets, acceptanceCriteria[], and failureCriteria[]; do not use workspace root, project root, ".", "/", or wildcard targets. It must not include codeBlocks, actionBundle, commandBlocks, patches, source code, or executable tool calls.'
        : '',
      allows('actionBundle')
        ? 'For kind="actionBundle", put userPlanMarkdown, codeBlocks, and actionBundle directly on the top-level JSON object. Do not wrap them in a payload object. validationExpectations[] and reviewExpectations[] are optional provider notes; Session derives routine defaults when they are omitted.'
        : '',
      allows('taskOutcome')
        ? 'For kind="taskOutcome", put taskOutcome:{version:"1",id,taskId,status:"modelJudgedSufficient",reason,evidenceRefs:[]} on the top-level JSON object. Use it only for the current accepted task when no Kernel action is needed.'
        : '',
      allows('actionBundle')
        ? 'codeBlocks[] uses {blockId,targetPath,language?,operation?,contentLines,allowEmptyContent?}; contentLines is the only source-code carrier.'
        : '',
      allows('actionBundle')
        ? 'fs.write actions use args={path,sourceBlockId}; sourceBlockId must match the blockId of the codeBlock carrying that exact file content.'
        : '',
      allows('actionBundle')
        ? 'Directory targets such as src/ are planning scopes only. Do not create empty .gitkeep or placeholder files unless the user explicitly requested that concrete file. For new files, write the concrete file and let Kernel create parent directories.'
        : '',
      allows('actionBundle')
        ? 'Empty content is valid only for operation="createEmpty" on an explicit empty file, or for patch/replace/insert operations when the protocol explicitly permits it.'
        : '',
      'Never output permissionLabels, accessScopes, resourceScope, commandBlocks, or legacy implementationPlan. capability is allowed only as taskPlan.tasks[].capability; actionBundle actions must use toolId and must not output capability fields.',
    ].filter(Boolean);
    if (allows('actionBundle') && (errorCode === 'invalid_action_bundle' || errorCode === 'invalid_object')) {
      common.push(
        `Minimal actionBundle skeleton:\n${this.minimalActionBundleRepairSkeleton()}`
      );
    }
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
      || errorCode === 'invalid_action_bundle_continuation'
      || errorCode === 'action_bundle_budget_exceeded';
  }

  private minimalActionBundleRepairSkeleton(): string {
    return JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'actionBundle',
      outputLanguage: 'zh-CN',
      userPlanMarkdown: '# Plan\n\n## Summary\n...\n\n## Key Changes\n...\n\n## Interfaces\n...\n\n## Test Plan\n...\n\n## Assumptions\n...',
      codeBlocks: [
        {
          blockId: 'block-1',
          targetPath: 'relative/file.ext',
          language: 'text',
          operation: 'create',
          contentLines: ['line 1', 'line 2'],
        },
      ],
      actionBundle: {
        version: '1',
        id: 'batch-id',
        goal: '...',
        actions: [
          {
            actionId: 'write-file',
            toolId: 'fs.write',
            args: { path: 'relative/file.ext', sourceBlockId: 'block-1' },
            description: 'Create the file.',
          },
        ],
        validationExpectations: [{ id: 'validation-1', description: 'Kernel facts show the expected file operation.' }],
        reviewExpectations: [{ id: 'review-1', description: 'Review the written file and Kernel facts.' }],
      },
    }, null, 2);
  }

  private minimalTaskPlanRepairSkeleton(): string {
    return JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
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
            capability: 'fs.write',
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
