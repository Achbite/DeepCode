import type {
  AgentEvent,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
} from '@deepcode/protocol';
import type { ActionBundleDraft, ProposalEnvelope } from '../index.js';
import { randomSmokeToken } from './smokeHelpers.js';

export function genericSessionResult(sessionId: string): AgentSessionResult {
  return {
    session: {
      id: sessionId,
      mode: 'plan',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      eventCount: 0,
    },
    events: [],
  };
}

export function genericProposal(id: string, kind: string): ProposalEnvelope {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    proposalId: `proposal-${id}`,
    runId: `run-${id}`,
    sessionId: `session-${id}`,
    source: 'llm',
    kind,
    payload: {},
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  } as ProposalEnvelope;
}

export function genericWriteProposal(missingEvidence: boolean): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Create the first small, reviewable scaffold batch for a generic workspace change after user approval.',
      '',
      '## Key Changes',
      '- Write one scoped output file from a top-level code block.',
      '- Keep this batch intentionally small so Kernel facts and user review can inspect the exact file scope.',
      '',
      '## Interfaces',
      '- Use fs.write with sourceBlockId to connect the planned action to the generated code block.',
      '- Do not invoke shell, git, browser, network, or any unsupported capability in this batch.',
      '',
      '## Test Plan',
      '- Kernel should record a write fact for the planned file path.',
      '- User review should inspect the generated path and content before accepting completion.',
      '',
      '## Assumptions',
      '- The target path is inside the authorized workspace or conversation root.',
      '- Follow-up batches, if any, require review before continuation.',
    ].join('\n'),
    codeBlocks: [{
      blockId: 'generic-block',
      targetPath: 'generic-output.txt',
      contentLines: ['generic content'],
    }],
    actionBundle: {
      version: '1',
      id: 'generic-write-bundle',
      goal: 'Create a generic scaffold.',
      actions: [{
        actionId: 'write-generic-output',
        toolId: 'fs.write',
        args: { path: 'generic-output.txt', sourceBlockId: 'generic-block' },
        description: 'Write generic output.',
      }],
      continuationExpectations: [],
      validationExpectations: missingEvidence
        ? []
        : [{ id: 'generic-evidence', description: 'Kernel records the write fact for the generic output.' }],
      reviewExpectations: missingEvidence
        ? []
        : [{ id: 'generic-review', description: 'User reviews the generic output and write scope.' }],
    },
    expectedValidation: 'Kernel records write facts for the generic output.',
    reviewGuide: 'Review the generic output path and content before approval.',
  };
}

export function genericTaskPlanProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'taskPlan',
    outputLanguage: 'en-US',
    taskPlan: {
      version: '1',
      id: 'task-plan-generic',
      title: 'Generic task plan',
      summary: 'Plan a generic workspace change before implementation.',
      tasks: [
        {
          taskId: 'task-generic-write',
          title: 'Prepare generic workspace output',
          target: ['generic-output.txt'],
          capability: 'fs.write',
          dependencies: [],
          conflictKeys: ['generic-output.txt'],
          acceptanceCriteria: ['Kernel facts show the accepted target was updated after Complete stage.'],
          failureCriteria: ['Stop if implementation needs targets outside the accepted task plan.'],
        },
      ],
      risks: ['Workspace writes remain under Kernel permission policy.'],
      reviewCheckpoints: ['Review Kernel facts after Complete stage execution.'],
    },
  };
}

export function absoluteTargetWriteProposal(targetPath: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    blockId: 'generic-block',
    targetPath,
    contentLines: ['generic content'],
  }];
  (proposal.actionBundle as any).actions[0].args = { path: targetPath, sourceBlockId: 'generic-block' };
  return proposal;
}

export function genericPatchProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Patch one previously reviewed generic file using an exact block copied from current ResourcePacket evidence.',
      '',
      '## Key Changes',
      '- Replace a single generic text block instead of rewriting the whole file.',
      '- Keep the edit anchored by patchSpec.match so Kernel can apply the change fail-closed.',
      '',
      '## Interfaces',
      '- Use fs.write with kind=replaceBlock and replacementBlockId.',
      '- Use patchSpec.match.kind=exactBlock with text from current file or search evidence.',
      '',
      '## Test Plan',
      '- Kernel should record a patch work unit for the target file.',
      '- User review should inspect the patch target and generated replacement.',
      '',
      '## Assumptions',
      '- The target file is within the already accepted implementation plan scope.',
      '- The exact match block is present in the latest ResourcePacket evidence.',
    ].join('\n'),
    codeBlocks: [{
      blockId: 'generic-patch-replacement',
      targetPath: 'generic-patch.txt',
      operation: 'replaceBlock',
      contentLines: ['new generic line'],
    }],
    actionBundle: {
      version: '1',
      id: 'generic-patch-bundle',
      goal: 'Patch a generic file with exact evidence.',
      actions: [{
        actionId: 'patch-generic-output',
        toolId: 'fs.patch',
        args: {
          path: 'generic-patch.txt',
          replacementBlockId: 'generic-patch-replacement',
          patchSpec: {
            match: {
              kind: 'exactBlock',
              text: 'old generic line',
            },
          },
        },
        description: 'Patch generic output.',
      }],
      continuationExpectations: [],
      validationExpectations: [{ id: 'generic-patch-evidence', description: 'Kernel records the patch fact for the generic file.' }],
      reviewExpectations: [{ id: 'generic-patch-review', description: 'User reviews the generic patch scope.' }],
    },
    expectedValidation: 'Kernel records patch facts for the generic file.',
    reviewGuide: 'Review the generic patch target and replacement before approval.',
  };
}

export function relativeTargetWriteProposal(targetPath: string, blockId: string, actionId: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    blockId,
    targetPath,
    contentLines: [`content for ${targetPath}`],
  }];
  (proposal.actionBundle as any).id = `bundle-${actionId}`;
  (proposal.actionBundle as any).actions[0].actionId = actionId;
  (proposal.actionBundle as any).actions[0].description = `Write ${targetPath}`;
  (proposal.actionBundle as any).actions[0].args = { path: targetPath, sourceBlockId: blockId };
  return proposal;
}

export function genericDecisionRequestProposal(id: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'decisionRequest',
    outputLanguage: 'en-US',
    decisionRequest: {
      version: '1',
      id,
      reason: 'A generic accepted-plan choice is needed before continuing the current task.',
      summary: 'Choose how to continue the current accepted task.',
      options: [
        { id: 'continue', label: 'Continue', description: 'Continue the same accepted task cursor.', recommended: true },
        { id: 'revise', label: 'Revise', description: 'Ask for revised guidance before continuing.' },
      ],
      allowsFreeform: true,
    },
  };
}

export function genericDirectoryResourceEvent(sessionId: string, directoryPath: string, filePaths: string[]): AgentEvent {
  const normalizedDirectory = directoryPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    id: `resource-${normalizedDirectory.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    payload: {
      output: {
        id: `resource-packet-${normalizedDirectory.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
        workspaceScopeKey: 'workspace',
        requestId: 'resource-request-generic-directory',
        items: [{
          requestItemId: 'item-directory',
          manifestEntryId: 'attachment-generic',
          status: 'resolved',
          contentKind: 'directoryTree',
          nodes: [
            {
              name: normalizedDirectory.split('/').pop() ?? normalizedDirectory,
              path: normalizedDirectory,
              type: 'directory',
              children: filePaths.map((path) => ({
                name: path.split('/').pop() ?? path,
                path,
                type: 'file',
                children: null,
              })),
            },
          ],
        }],
      },
    },
  };
}

export function deleteActionBundleProposal(targetPath: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Delete one generic obsolete file already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one fs.delete action with a concrete relative target.',
      '',
      '## Interfaces',
      '- Use fs.delete directly; do not attach codeBlocks or sourceBlockId.',
      '',
      '## Test Plan',
      '- Kernel should record a delete work unit fact for the target.',
      '',
      '## Assumptions',
      '- The delete target is inside the accepted workspace scope.',
    ].join('\n'),
    codeBlocks: [],
    actionBundle: {
      version: '1',
      id: 'bundle-generic-delete',
      goal: 'Delete a generic obsolete file.',
      actions: [{
        actionId: 'delete-generic-obsolete',
        toolId: 'fs.delete',
        args: { path: targetPath },
        description: 'Delete generic obsolete file.',
      }],
      continuationExpectations: [],
      validationExpectations: [{ id: 'generic-delete-evidence', description: 'Kernel records the delete fact for the generic obsolete file.' }],
      reviewExpectations: [{ id: 'generic-delete-review', description: 'User reviews the deleted target and Kernel facts.' }],
    },
    expectedValidation: 'Kernel records delete facts for the generic obsolete file.',
    reviewGuide: 'Review the generic delete target before approval.',
  };
}

export function manyDeleteActionsProposal(): Record<string, unknown> {
  const proposal = deleteActionBundleProposal('generic-0.tmp');
  (proposal.actionBundle as any).id = 'bundle-many-generic-delete';
  (proposal.actionBundle as any).goal = 'Delete several generic obsolete files.';
  (proposal.actionBundle as any).actions = Array.from({ length: 7 }, (_item, index) => ({
    actionId: `delete-generic-${index}`,
    toolId: 'fs.delete',
    args: { path: `generic-${index}.tmp` },
    description: `Delete generic obsolete file ${index}.`,
  }));
  return proposal;
}

export function localizedGenericWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.outputLanguage = 'zh-CN';
  proposal.userPlan = [
    '# 通用计划',
    '',
    '## 概要',
    '为一个通用工作区变更创建一个小批次，保持范围可审查，并等待 Kernel 记录真实执行事实后再进入审查。',
    '',
    '## 关键变更',
    '- 从顶层代码块写入一个受控输出文件。',
    '- 保持本批次足够小，方便用户检查路径、内容和权限范围。',
    '',
    '## 接口与影响面',
    '- 使用 fs.write 与 sourceBlockId 连接计划动作和代码块。',
    '- 不调用命令、Git、网络、浏览器或其他外部能力。',
    '',
    '## 验证计划',
    '- Kernel 应记录目标路径的写入事实。',
    '- 用户审查时应能看到生成文件路径和内容摘要。',
    '',
    '## 假设与约束',
    '- 目标路径位于已授权的工作区或会话资源根内。',
    '- 后续批次仍需要新的计划确认和审查。',
  ].join('\n');
  return proposal;
}

export function oversizedGenericWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    blockId: 'generic-oversized-block',
    targetPath: 'generic-oversized-output.txt',
    contentLines: ['x'.repeat(385 * 1024)],
  }];
  (proposal.actionBundle as any).actions[0].args = { path: 'generic-oversized-output.txt', sourceBlockId: 'generic-oversized-block' };
  return proposal;
}

export function manyCodeBlockWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = Array.from({ length: 7 }, (_item, index) => ({
    blockId: `generic-block-${index}`,
    targetPath: `generic-output-${index}.txt`,
    contentLines: [`generic content ${index}`],
  }));
  (proposal.actionBundle as any).actions = Array.from({ length: 7 }, (_item, index) => ({
    actionId: `write-generic-output-${index}`,
    toolId: 'fs.write',
    args: { path: `generic-output-${index}.txt`, sourceBlockId: `generic-block-${index}` },
    description: `Write generic output ${index}.`,
  }));
  return proposal;
}

export function providerFacingWriteProposalWithoutMachineIds(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  delete (proposal.actionBundle as any).id;
  proposal.codeBlocks = [{
    blockId: 'generic-block',
    targetPath: 'generic-output.txt',
    language: 'text',
    operation: 'create',
    contentLines: ['generic content'],
  }];
  (proposal.actionBundle as any).actions = [{
    actionId: 'write-generic-output',
    description: 'Write generic output',
    toolId: 'fs.write',
    args: { path: 'generic-output.txt', sourceBlockId: 'generic-block' },
    dependsOn: [],
  }];
  return proposal;
}

export function jsonLlmResponse(payload: Record<string, unknown>): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'reasoning_delta', content: 'generic reasoning' }, { type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        reasoningContent: 'generic reasoning',
        content: JSON.stringify(payload),
      },
    },
  };
}

export function planKernel(
  request: KernelCommandEnvelope,
  sessionId: string,
  submittedPlans: Array<Record<string, any>>
): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') return fakeKernel(request);
  if (command.kind === 'proposalSubmit') {
    submittedPlans.push(command.proposal);
    const actionBundle = command.proposal?.payload?.actionBundle ?? {};
    return {
      ok: true,
      events: [
        {
          kind: 'proposal.accepted',
          runId: 'run-generic',
          sessionId,
          proposal: command.proposal,
        },
        {
          kind: 'proposal.reviewed',
          runId: 'run-generic',
          sessionId,
          proposalId: command.proposal?.proposalId,
          report: proposalReviewReport(actionBundle),
        },
      ],
    };
  }
  if (command.kind === 'reviewGateEvaluate') {
    return {
      ok: true,
      events: [
        {
          kind: 'review_gate.evaluated',
          runId: command.runId ?? 'run-generic',
          sessionId: command.sessionId ?? sessionId,
          result: {
            status: 'accepted',
            summary: 'ReviewGate accepted Kernel facts and user review decision.',
          },
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

export function proposalReviewReport(actionBundle: Record<string, any>, attachmentRoot?: string): Record<string, any> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const capabilities = [...new Set(actions.map((action) => actionCapability(action)).filter(Boolean))].sort();
  const permissionGaps = capabilities.filter((capability) => capability !== 'fs.read' && capability !== 'git.read');
  const requiredFileOperations = requiredFileOperationsFromActionBundle(actionBundle, attachmentRoot);
  const requiredAccessScopes = requiredAccessScopesFromActionBundle(actionBundle);
  return {
    planId: actionBundle.id ?? 'bundle-generic',
    status: 'awaitingUserApproval',
    requiredCapabilities: capabilities,
    requiredPermissions: permissionGaps.map((capability) => `temporaryGrant:${capability}`),
    permissionGaps,
    requiredFileOperations,
    requiredAccessScopes,
    hardFloorHits: [],
    deniedReasons: [],
    blockedReasons: [],
    findings: [],
    kernelGeneratedPermissionSummary: `Kernel preflight: status=awaitingUserApproval; capabilities=${capabilities.join(',')}; permissionGaps=${permissionGaps.length ? permissionGaps.join(',') : 'none'}; hardFloor=none.`,
  };
}

export function requiredAccessScopesFromActionBundle(actionBundle: Record<string, any>): Array<Record<string, any>> {
  const scopes: Array<Record<string, any>> = [];
  const source = [
    ...(Array.isArray(actionBundle.accessScopes) ? actionBundle.accessScopes : []),
    ...((Array.isArray(actionBundle.actions) ? actionBundle.actions : []).flatMap((action: any) =>
      Array.isArray(action?.accessScopes) ? action.accessScopes : []
    )),
  ];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const path = typeof item.path === 'string' ? item.path.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (!path || path === '.' || path.includes('*') || path.startsWith('../') || path.includes('/../')) continue;
    const capability = typeof item.capability === 'string'
      ? item.capability
      : Array.isArray(item.capabilities) && typeof item.capabilities[0] === 'string'
        ? item.capabilities[0]
        : 'fs.write';
    scopes.push({
      scopeKind: typeof item.scopeKind === 'string' ? item.scopeKind : 'workspaceModule',
      path,
      capability,
      operations: Array.isArray(item.operations) ? item.operations : (capability === 'fs.patch' ? ['patch'] : ['create', 'write']),
      reason: typeof item.reason === 'string' ? item.reason : 'generic access scope',
      dependencyDepth: typeof item.dependencyDepth === 'number' ? item.dependencyDepth : 0,
      outsideWorkspace: false,
    });
  }
  return scopes;
}

export function requiredFileOperationsFromActionBundle(actionBundle: Record<string, any>, attachmentRoot?: string): Array<Record<string, any>> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const operations: Array<Record<string, any>> = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const capability = actionCapability(action);
    const operation = fileOperationForAction(action, capability);
    if (!operation) continue;
    const args = action && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : {};
    const targetKind = typeof args.targetKind === 'string' ? args.targetKind : action.targetKind;
    const targetResourceKind = action.targetResourceKind === 'directory' || targetKind === 'directory'
      ? 'directory'
      : typeof action.targetPath === 'string' && action.targetPath.trim().endsWith('/')
        ? 'directory'
        : 'file';
    const rawTarget = typeof action.targetPath === 'string'
      ? action.targetPath
      : Array.isArray(action.resourceScope) && typeof action.resourceScope[0] === 'string'
        ? action.resourceScope[0]
        : typeof args.path === 'string'
          ? args.path
        : '';
    const target = concreteTestTarget(
      targetResourceKind === 'directory' ? rawTarget.replace(/\/+$/, '') : rawTarget,
      attachmentRoot
    );
    if (!target) continue;
    const outsideWorkspace = isAbsoluteTestTarget(target);
    operations.push({
      operation,
      targetPath: target,
      capability,
      actionId: typeof action.actionId === 'string' ? action.actionId : typeof action.id === 'string' ? action.id : '',
      targetKind: outsideWorkspace ? 'absolutePath' : 'workspaceRelative',
      targetResourceKind,
      recursive: action.recursive === true || args.recursive === true || (targetResourceKind === 'directory' && rawTarget.trim().endsWith('/')),
      outsideWorkspace,
    });
  }
  return operations;
}

export function actionCapability(action: Record<string, any>): string {
  if (typeof action.capability === 'string' && action.capability) return action.capability;
  const toolId = typeof action.toolId === 'string' ? action.toolId : '';
  if (!toolId) return '';
  if (toolId.startsWith('git.')) return toolId === 'git.status' || toolId === 'git.diff' ? 'git.read' : (toolId === 'git.push' ? 'git.push' : 'git.write');
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
}

export function fileOperationForAction(action: Record<string, any>, capability: string): string | undefined {
  const kind = typeof action.kind === 'string' ? action.kind : '';
  if (kind === 'delete') return 'delete';
  if (kind === 'create') return 'create';
  if (kind === 'rename') return 'rename';
  if (['write', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(kind)) return 'write';
  if (capability === 'fs.write') return 'write';
  if (capability === 'fs.patch') return 'write';
  if (capability === 'fs.delete') return 'delete';
  return undefined;
}

export function concreteTestTarget(value: string, attachmentRoot?: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsoluteTestTarget(normalized)) {
    const root = attachmentRoot?.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized === '/' || /^[a-zA-Z]:\/?$/.test(normalized)) return undefined;
    if (!root) {
      if (normalized.includes('*') || normalized.endsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
      return normalized;
    }
    if (normalized === root) return undefined;
    if (normalized.startsWith(`${root}/`)) return concreteTestTarget(normalized.slice(root.length + 1));
    if (normalized.includes('*') || normalized.endsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) return undefined;
    return normalized;
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*') || normalized.endsWith('/')) return undefined;
  return normalized;
}

export function isAbsoluteTestTarget(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

export function genericActionBundle(): ActionBundleDraft {
  return {
    version: '1',
    id: 'bundle-generic',
    goal: 'Perform a generic workspace update after review.',
    actions: [
      {
        id: 'read-generic',
        title: 'Read generic resource',
        toolId: 'fs.read',
        args: { path: 'generic/input.txt' },
        kind: 'read',
        capability: 'fs.read',
        resourceScope: ['generic/input.txt'],
        canParallelize: true,
        conflictKeys: [],
      },
      {
        id: 'write-generic',
        title: 'Write generic resource',
        toolId: 'fs.write',
        args: { path: 'generic/output.txt', sourceBlockId: 'code-generic' },
        kind: 'write',
        capability: 'fs.write',
        resourceScope: ['generic/output.txt'],
        canParallelize: false,
        conflictKeys: ['generic/output.txt'],
        sourceBlockId: 'code-generic',
      },
    ],
    validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
    reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
  };
}

export function acceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  return {
    id: `event-${runId}-implementation-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId: 'impl-generic-auto',
      title: 'Generic implementation plan',
      summary: 'Implement a generic workspace file update.',
      status: 'pending',
      confirmable: true,
      implementationPlan: {
        version: '1',
        id: 'impl-generic-auto',
        title: 'Generic implementation plan',
        summary: 'Implement a generic workspace file update.',
        tasks: [
          {
            taskId: 'task-generic-write',
            title: 'Write generic output',
            target: ['generic-output.txt'],
            scope: 'Write a generic output file.',
            dependencies: [],
            capability: 'fs.write',
            acceptanceCriteria: ['Kernel records the generic output write fact.'],
            failureCriteria: ['Stop if the write leaves the accepted target scope.'],
          },
        ],
        risks: ['Workspace writes remain under Kernel permission policy.'],
        reviewCheckpoints: ['Review Kernel facts after execution.'],
      },
      actionBundle: {
        version: '1',
        id: 'impl-generic-auto',
        goal: 'Implementation plan placeholder; concrete batches are generated after acceptance.',
        actions: [],
        validationExpectations: [],
        reviewExpectations: [],
      },
      codeBlocks: [],
      commandBlocks: [],
    },
  };
}

export function readOnlyAcceptedImplementationPlanCardEvent(
  sessionId: string,
  runId: string,
  token: string,
  targets: string[]
): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = `impl-${token}`;
  payload.implementationPlan.id = `impl-${token}`;
  payload.implementationPlan.title = 'Random read-only validation plan';
  payload.implementationPlan.summary = 'Resolve current evidence for accepted read-only targets.';
  payload.implementationPlan.tasks = [
    {
      taskId: `task-${token}-read`,
      title: 'Validate random accepted targets',
      target: targets,
      scope: 'Resolve current read-only evidence for the accepted targets.',
      dependencies: [],
      capability: 'fs.read',
      acceptanceCriteria: ['ResourcePacket covers every accepted target.'],
      failureCriteria: ['Stop if current evidence cannot cover each target.'],
    },
  ];
  payload.actionBundle = {
    version: '1',
    id: `impl-${token}`,
    goal: 'Read-only validation placeholder; evidence is resolved after acceptance.',
    actions: [],
    validationExpectations: [{ id: `validation-${token}`, description: 'Resource evidence covers all accepted targets.' }],
    reviewExpectations: [{ id: `review-${token}`, description: 'User reviews the read-only validation checkpoint.' }],
  };
  return event;
}

export function generatedArtifactAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generated-artifact';
  payload.implementationPlan.id = 'impl-generated-artifact';
  payload.implementationPlan.title = 'Generic generated artifact implementation plan';
  payload.implementationPlan.summary = 'Write one file, then read it as current evidence for a dependent write.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generated-input',
      title: 'Write generated input',
      target: ['generic-generated/input.txt'],
      scope: 'Create a generic input artifact inside the accepted workspace scope.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generated input write fact.'],
      failureCriteria: ['Stop if the write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generated-output',
      title: 'Write generated output',
      target: ['generic-generated/output.txt'],
      scope: 'Read the generated input evidence, then create a dependent output artifact.',
      dependencies: ['task-generated-input'],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the generated output write fact.'],
      failureCriteria: ['Stop if the generated input evidence cannot be resolved.'],
    },
  ];
  return event;
}

export function userMessageWithDirectoryAttachmentEvent(sessionId: string, root: string): AgentEvent {
  return {
    id: `event-${sessionId}-user-attachment`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: {
      content: 'Please update the generic workspace.',
      attachments: [{
        kind: 'directory',
        path: root,
        absolutePath: root,
        source: 'userSelected',
        scope: 'message',
      }],
    },
  };
}

export function multiTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-multi';
  payload.implementationPlan.id = 'impl-generic-multi';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-one',
      title: 'Write generic file one',
      target: ['generic-one.txt'],
      scope: 'Write the first generic file.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the first generic write fact.'],
      failureCriteria: ['Stop if the first write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generic-two',
      title: 'Write generic file two',
      target: ['generic-two.txt'],
      scope: 'Write the second generic file.',
      dependencies: ['task-generic-one'],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the second generic write fact.'],
      failureCriteria: ['Stop if the second write leaves the accepted target scope.'],
    },
  ];
  return event;
}

export function tripleTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string, token: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = `impl-${token}`;
  payload.implementationPlan.id = `impl-${token}`;
  payload.implementationPlan.title = 'Generic ordered implementation plan';
  payload.implementationPlan.summary = 'Write three generic targets in accepted task order.';
  payload.implementationPlan.tasks = [
    {
      taskId: `task-${token}-one`,
      title: 'Write first generic target',
      target: [`generic-${token}-one.txt`],
      scope: 'Write the first accepted generic target.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the first generic write fact.'],
      failureCriteria: ['Stop if the first write leaves the accepted target scope.'],
    },
    {
      taskId: `task-${token}-two`,
      title: 'Write second generic target',
      target: [`generic-${token}-two.txt`],
      scope: 'Write the second accepted generic target.',
      dependencies: [`task-${token}-one`],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the second generic write fact.'],
      failureCriteria: ['Stop if the second write leaves the accepted target scope.'],
    },
    {
      taskId: `task-${token}-three`,
      title: 'Write third generic target',
      target: [`generic-${token}-three.txt`],
      scope: 'Write the third accepted generic target.',
      dependencies: [`task-${token}-two`],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records the third generic write fact.'],
      failureCriteria: ['Stop if the third write leaves the accepted target scope.'],
    },
  ];
  return event;
}

export function commaSeparatedTargetsAcceptedImplementationPlanCardEvent(sessionId: string, runId: string, paths: string[]): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-random-comma';
  payload.implementationPlan.id = 'impl-random-comma';
  payload.implementationPlan.title = 'Random multi-target implementation plan';
  payload.implementationPlan.summary = 'Write all accepted random targets as one reviewed execution batch.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-random-comma-targets',
      title: 'Write random accepted targets',
      target: [paths.join(', ')],
      scope: 'The task target field intentionally carries several concrete file targets in one path-list string.',
      dependencies: [],
      capability: 'fs.write',
      acceptanceCriteria: ['Kernel records write work unit facts for every accepted target.'],
      failureCriteria: ['Stop if any action leaves the accepted target scope.'],
    },
  ];
  return event;
}

export function independentMultiTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-independent';
  payload.implementationPlan.id = 'impl-generic-independent';
  for (const task of payload.implementationPlan.tasks ?? []) {
    task.dependencies = [];
  }
  return event;
}

export function deleteAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-delete';
  payload.implementationPlan.id = 'impl-generic-delete';
  payload.implementationPlan.title = 'Generic delete implementation plan';
  payload.implementationPlan.summary = 'Remove one generic obsolete workspace file.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-delete',
      title: 'Delete generic obsolete file',
      target: ['generic-obsolete.txt'],
      scope: 'Delete a generic obsolete file inside the accepted workspace scope.',
      dependencies: [],
      capability: 'fs.delete',
      acceptanceCriteria: ['Kernel records the delete work unit fact for the generic obsolete file.'],
      failureCriteria: ['Stop if the delete target is empty, root, absolute, or outside the accepted target scope.'],
    },
  ];
  return event;
}

export function multiDeleteAcceptedImplementationPlanCardEvent(
  sessionId: string,
  runId: string,
  token: string,
  targets: string[]
): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = `impl-${token}`;
  payload.implementationPlan.id = `impl-${token}`;
  payload.implementationPlan.title = 'Generic multi-delete implementation plan';
  payload.implementationPlan.summary = 'Remove several accepted cleanup targets in one current task batch.';
  payload.implementationPlan.tasks = [
    {
      taskId: `task-${token}`,
      title: 'Delete accepted cleanup targets',
      target: targets,
      scope: 'Delete only the accepted cleanup targets listed by this task.',
      dependencies: [],
      capability: 'fs.delete',
      acceptanceCriteria: ['Kernel records delete work unit facts for every accepted cleanup target.'],
      failureCriteria: ['Stop if any delete action leaves the accepted target scope.'],
    },
  ];
  return event;
}

export function directoryDeleteAcceptedImplementationPlanCardEvent(
  sessionId: string,
  runId: string,
  dirPath: string,
  childNames: string[]
): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  const planId = `impl-${dirPath.replace(/[^A-Za-z0-9_.-]+/g, '-')}`;
  payload.planId = planId;
  payload.implementationPlan.id = planId;
  payload.implementationPlan.title = 'Generic directory delete implementation plan';
  payload.implementationPlan.summary = 'Remove one accepted directory as a single current-task delete.';
  payload.implementationPlan.tasks = [
    {
      taskId: `task-${dirPath.replace(/[^A-Za-z0-9_.-]+/g, '-')}`,
      title: 'Delete accepted directory target',
      target: [`${dirPath} (${childNames.join(', ')})`],
      scope: 'The task target field intentionally combines one directory path with human-readable child examples.',
      dependencies: [],
      capability: 'fs.delete',
      acceptanceCriteria: ['Kernel records a directory delete work unit fact for the accepted target.'],
      failureCriteria: ['Stop if the delete target leaves the accepted directory target scope.'],
    },
  ];
  return event;
}

export function singleTargetWriteProposal(targetPath: string, contentSuffix: string): Record<string, unknown> {
  const blockId = `code-${contentSuffix}`;
  const actionId = `write-${contentSuffix}`;
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Generic task slice',
      '',
      '## Summary',
      `Write the accepted target ${targetPath} as one independent task slice.`,
      '',
      '## Key Changes',
      '- Produce one code block for the accepted target.',
      '- Produce one fs.write action scoped to that same target.',
      '- Do not introduce shell, git, network, browser, or provider egress actions.',
      '',
      '## Validation',
      '- Kernel should record a work unit for the accepted target.',
      '- Parent Session should merge this fragment with sibling independent fragments before submitting.',
      '',
      '## Assumptions',
      '- The target belongs to the accepted implementationPlan file scope.',
    ].join('\n'),
    codeBlocks: [
      { blockId, targetPath, contentLines: [`generic ${contentSuffix}`] },
    ],
    actionBundle: {
      version: '1',
      id: `bundle-${contentSuffix}`,
      goal: `Write ${targetPath}.`,
      actions: [{
        actionId,
        toolId: 'fs.write',
        args: { path: targetPath, sourceBlockId: blockId },
        description: `Write ${targetPath}`,
      }],
      validationExpectations: [{ id: `validation-${contentSuffix}`, description: `Kernel records ${targetPath}.` }],
      reviewExpectations: [{ id: `review-${contentSuffix}`, description: `Review ${targetPath}.` }],
    },
    expectedValidation: `Kernel records ${targetPath}.`,
    reviewGuide: `Review ${targetPath}.`,
  };
}
export function genericDiagnosticProposal(summary: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'diagnostic',
    outputLanguage: 'en-US',
    diagnostic: {
      version: '1',
      id: 'diagnostic-generic',
      severity: 'warning',
      summary,
    },
  };
}

export function processExecAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-exec';
  payload.implementationPlan.id = 'impl-generic-exec';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-exec',
      title: 'Run generic validation',
      target: ['scripts/validate.sh'],
      scope: 'Run a generic validation command described by the accepted plan.',
      dependencies: [],
      capability: 'process.exec',
      acceptanceCriteria: ['Kernel permission gate owns the process execution decision.'],
      failureCriteria: ['Stop if Session asks for a new technical plan instead of using Kernel PermissionGate.'],
    },
  ];
  return event;
}

export function multiWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [
    { id: 'code-one', targetPath: 'generic-one.txt', content: 'one' },
    { id: 'code-two', targetPath: 'generic-two.txt', content: 'two' },
  ];
  proposal.actionBundle = multiWriteActionBundle();
  return proposal;
}

export function randomMultiWriteProposal(paths: string[], options?: { briefUserPlan?: boolean }): Record<string, unknown> {
  const token = randomSmokeToken('bundle');
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: options?.briefUserPlan
      ? `## Batch\n\nWrite ${paths.length} accepted target file(s).`
      : [
        '# Random multi-target batch',
        '',
        '## Summary',
        `Write ${paths.length} accepted target file(s) in one reviewed execution batch.`,
        '',
        '## Key Changes',
        '- Produce one code block for each accepted target path.',
        '- Produce one fs.write action for each code block.',
        '- Keep every write target inside the already accepted implementation plan scope.',
        '',
        '## Validation',
        '- Kernel should record one work unit fact for each target path.',
        '- Session should not create a user-intervention request for in-scope targets.',
        '',
        '## Assumptions',
        '- The accepted implementation plan already declared the target paths.',
      ].join('\n'),
    codeBlocks: paths.map((path, index) => ({
      blockId: `code-${token}-${index}`,
      targetPath: path,
      contentLines: [`content ${randomSmokeToken('content')}`],
    })),
    actionBundle: {
      version: '1',
      id: `bundle-${token}`,
      goal: 'Write accepted random target files.',
      actions: paths.map((path, index) => ({
        actionId: `write-${token}-${index}`,
        toolId: 'fs.write',
        args: { path, sourceBlockId: `code-${token}-${index}` },
        description: `Write ${path}`,
        canParallelize: false,
        conflictKeys: [path],
      })),
      validationExpectations: [{ id: `validation-${token}`, description: 'Kernel records write work unit facts for all target paths.' }],
      reviewExpectations: [{ id: `review-${token}`, description: 'User reviews the generated target files and Kernel facts.' }],
    },
    expectedValidation: 'Kernel records write facts for all target paths.',
    reviewGuide: 'Review the generated files and Kernel facts.',
  };
}

export function multiWriteActionBundle(): Record<string, any> {
  return {
    version: '1',
    id: 'bundle-multi-write',
    goal: 'Write multiple generic files in one reviewed batch.',
    actions: [
      {
        actionId: 'write-generic-one',
        toolId: 'fs.write',
        args: { path: 'generic-one.txt', sourceBlockId: 'code-one' },
        description: 'Write generic file one.',
        canParallelize: false,
        conflictKeys: ['generic-one.txt'],
      },
      {
        actionId: 'write-generic-two',
        toolId: 'fs.write',
        args: { path: 'generic-two.txt', sourceBlockId: 'code-two' },
        description: 'Write generic file two.',
        canParallelize: false,
        conflictKeys: ['generic-two.txt'],
      },
    ],
    validationExpectations: [{ id: 'validation-multi', description: 'Kernel records file write facts.' }],
    reviewExpectations: [{ id: 'review-multi', description: 'User reviews all written files.' }],
  };
}

export function processExecProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Run the generic validation command already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one planned process execution action with typed command args.',
      '- Keep the command inside the accepted target and capability scope.',
      '',
      '## Interfaces',
      '- Use process.exec with argv/cwd args so Kernel owns permission and execution.',
      '',
      '## Test Plan',
      '- Kernel should either request permission or record command execution facts.',
      '',
      '## Assumptions',
      '- The command target was already included in the accepted implementation plan.',
    ].join('\n'),
    actionBundle: {
      version: '1',
      id: 'bundle-generic-exec',
      goal: 'Run generic validation.',
      actions: [{
        actionId: 'run-generic-validation',
        toolId: 'process.exec',
        args: {
          cwd: '.',
          argv: ['bash', 'scripts/validate.sh'],
          timeoutMs: 30000,
          envPolicy: 'inheritSafe',
          expectedOutput: 'generic validation output',
          targetPath: 'scripts/validate.sh',
        },
        description: 'Run generic validation',
      }],
      validationExpectations: [{ id: 'validation-exec', description: 'Kernel records permission or command facts for the generic validation.' }],
      reviewExpectations: [{ id: 'review-exec', description: 'User can inspect Kernel permission and command facts.' }],
    },
    expectedValidation: 'Kernel records permission or command facts for the generic validation.',
    reviewGuide: 'Review Kernel permission and command facts.',
  };
}

export function fakeKernel(request: KernelCommandEnvelope): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') {
    const toolCatalogSnapshot = genericToolCatalogSnapshot();
    return {
      ok: true,
      events: [
        {
          kind: 'state.entered',
          runId: 'run-generic',
          sessionId: 'session-generic',
          stateContract: {
            runId: 'run-generic',
            stateId: 'needProposal',
            stateKind: 'driverRequest',
            allowedInputs: ['proposalSubmit', 'resourceResolve'],
            allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
            proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
            capabilityProjection: ['fs.read', 'fs.write'],
            toolCatalogSnapshot,
          },
        },
        {
          kind: 'driver.request_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          driverRequest: {
            id: 'driver-generic',
            runId: 'run-generic',
            sessionId: 'session-generic',
            kind: 'needProposal',
            reason: 'Need a v3 proposal.',
            stateContract: {
              runId: 'run-generic',
              stateId: 'needProposal',
              stateKind: 'driverRequest',
              allowedInputs: ['proposalSubmit', 'resourceResolve'],
              allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
              proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
              capabilityProjection: ['fs.read', 'fs.write'],
              toolCatalogSnapshot,
            },
          },
        },
      ],
    };
  }
  if (command.kind === 'resourceResolve') {
    return {
      ok: true,
      events: [
        {
          kind: 'resource.packet_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          packet: {
            id: 'packet-generic',
            requestId: command.requestId,
            items: [
              {
                requestItemId: 'item-generic',
                manifestEntryId: command.request.manifest.entries[0].id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: 'file',
                contentKind: 'fileText',
                content: 'resolved generic content',
                evidenceRefs: ['evidence-generic'],
              },
            ],
          },
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

export function genericToolCatalogSnapshot(): Record<string, unknown> {
  const base = {
    family: 'workspace',
    risk: 'low',
    permissionMode: 'allow',
    pathScopePolicy: 'workspace',
    executionMode: 'execute',
    needsWorkspace: true,
    readOnly: true,
  };
  return {
    catalogVersion: 'test-v1',
    catalogHash: 'test-tool-catalog',
    tools: [
      {
        ...base,
        toolId: 'fs.read',
        capability: 'fs.read',
        operationKind: 'read',
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        ...base,
        toolId: 'fs.list',
        capability: 'fs.read',
        operationKind: 'list',
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        ...base,
        toolId: 'fs.write',
        capability: 'fs.write',
        operationKind: 'write',
        permissionMode: 'ask',
        readOnly: false,
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, sourceBlockId: { type: 'string' } },
          required: ['path', 'sourceBlockId'],
        },
      },
    ],
  };
}

export function fakeLlm(_request: LlmChatRequest): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'The attached generic resource was resolved through Kernel ResourceResolve.' },
        }),
      },
    },
  };
}
