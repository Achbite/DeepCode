import type {
  AgentEvent,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelEventV1,
  KernelPermissionRequestEnvelope,
  KernelPlanAuthorizationContract,
  KernelProposalReviewReport,
  KernelReply,
  KernelResourcePacket,
  KernelReviewFacts,
  KernelToolOperationKind,
  KernelWorkUnitDescriptor,
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
    schemaVersion: 'deepcode.agent.protocol.v4',
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
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlanMarkdown: [
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
      '- Use fs.write with contentBlockId to connect the planned action to the generated code block.',
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
    contentBlocks: [{
      blockId: 'generic-block',
      targetPath: 'generic-output.txt',
      operation: 'overwrite',
      contentLines: ['generic content'],
    }],
    actionBundle: {
      version: '1',
      id: 'generic-write-bundle',
      goal: 'Create a generic scaffold.',
      actions: [{
        actionId: 'write-generic-output',
        toolId: 'fs.write',
        args: { path: 'generic-output.txt', contentBlockId: 'generic-block' },
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
  };
}

export function genericTaskPlanProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
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
          toolId: 'fs.create',
          args: {},
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
  proposal.contentBlocks = [{
    blockId: 'generic-block',
    targetPath,
    operation: 'overwrite',
    contentLines: ['generic content'],
  }];
  (proposal.actionBundle as any).actions[0].args = { path: targetPath, contentBlockId: 'generic-block' };
  return proposal;
}

export function genericPatchProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlanMarkdown: [
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
    contentBlocks: [{
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
        toolId: 'fs.edit',
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
  };
}

export function relativeTargetWriteProposal(targetPath: string, blockId: string, actionId: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.contentBlocks = [{
    blockId,
    targetPath,
    operation: 'overwrite',
    contentLines: [`content for ${targetPath}`],
  }];
  (proposal.actionBundle as any).id = `bundle-${actionId}`;
  (proposal.actionBundle as any).actions[0].actionId = actionId;
  (proposal.actionBundle as any).actions[0].description = `Write ${targetPath}`;
  (proposal.actionBundle as any).actions[0].args = { path: targetPath, contentBlockId: blockId };
  return proposal;
}

export function genericDecisionRequestProposal(id: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
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
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlanMarkdown: [
      '# Plan',
      '',
      '## Summary',
      'Delete one generic obsolete file already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one fs.delete action with a concrete relative target.',
      '',
      '## Interfaces',
      '- Use fs.delete directly; do not attach contentBlocks or contentBlockId.',
      '',
      '## Test Plan',
      '- Kernel should record a delete work unit fact for the target.',
      '',
      '## Assumptions',
      '- The delete target is inside the accepted workspace scope.',
    ].join('\n'),
    contentBlocks: [],
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
    '- 使用 fs.write 与 contentBlockId 连接计划动作和代码块。',
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

export function manyContentBlockWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.contentBlocks = Array.from({ length: 7 }, (_item, index) => ({
    blockId: `generic-block-${index}`,
    targetPath: `generic-output-${index}.txt`,
    operation: 'overwrite',
    contentLines: [`generic content ${index}`],
  }));
  (proposal.actionBundle as any).actions = Array.from({ length: 7 }, (_item, index) => ({
    actionId: `write-generic-output-${index}`,
    toolId: 'fs.write',
    args: { path: `generic-output-${index}.txt`, contentBlockId: `generic-block-${index}` },
    description: `Write generic output ${index}.`,
  }));
  return proposal;
}

export function providerFacingWriteProposalWithoutMachineIds(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  delete (proposal.actionBundle as any).id;
  proposal.contentBlocks = [{
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
    args: { path: 'generic-output.txt', contentBlockId: 'generic-block' },
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
  const command = request.command;
  if (command.kind === 'runCreate') return fakeKernel(request);
  if (command.kind === 'proposalSubmit') {
    submittedPlans.push(command.proposal);
    const proposalPayload = command.proposal.payload && typeof command.proposal.payload === 'object' && !Array.isArray(command.proposal.payload)
      ? command.proposal.payload as Record<string, unknown>
      : {};
    const actionBundle = proposalPayload.actionBundle && typeof proposalPayload.actionBundle === 'object' && !Array.isArray(proposalPayload.actionBundle)
      ? proposalPayload.actionBundle as Record<string, any>
      : {};
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
    const decision = command.decision?.decision;
    const status = decision === 'revise'
      ? 'needsReplan'
      : decision === 'reject'
        ? 'aborted'
        : 'accepted';
    return {
      ok: true,
      events: [
        {
          kind: 'review_gate.evaluated',
          runId: command.runId ?? 'run-generic',
          sessionId: command.sessionId ?? sessionId,
          result: {
            status,
            summary: `ReviewGate evaluated the ${decision ?? 'accept'} decision as ${status}.`,
          },
        },
      ],
    };
  }
  return fakeKernel(request);
}

export function proposalReviewReport(actionBundle: Record<string, any>, _attachmentRoot?: string): KernelProposalReviewReport {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const contractId = `contract-${actionBundle.id ?? 'bundle-generic'}`;
  const permissionGroups = new Map<string, Record<string, any>[]>();
  for (const action of actions) {
    const toolId = typeof action?.toolId === 'string' ? action.toolId : '';
    const capability = testKernelCapabilityForToolId(toolId);
    if (!capability || testKernelPermissionModeForToolId(toolId) === 'allow') continue;
    const group = permissionGroups.get(capability) ?? [];
    group.push(action);
    permissionGroups.set(capability, group);
  }
  const permissionBundles: KernelProposalReviewReport['executionContract']['permissionBundles'] = [...permissionGroups.entries()].map(([capability, groupedActions], index) => {
    const toolIds = [...new Set(groupedActions.map((action) => action.toolId).filter(Boolean))];
    const operationIds = groupedActions.map((action) => action.actionId).filter(Boolean);
    const targets = groupedActions.flatMap((action) => {
      const args = action && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : {};
      return [args.path, args.destinationPath, args.url].filter((value): value is string => typeof value === 'string' && Boolean(value));
    });
    return {
      id: `permission-${actionBundle.id ?? 'bundle-generic'}-${index + 1}`,
      capability,
      permissionMode: 'ask' as const,
      risk: toolIds.some((toolId) => ['fs.delete', 'fs.rename', 'git.push', 'process.exec'].includes(toolId)) ? 'high' as const : 'medium' as const,
      resourceKind: testKernelPermissionResourceKind(capability),
      operationIds,
      toolIds,
      targets,
      expiresAfter: 'reviewGateOrRunTerminal',
    };
  });
  const status = permissionBundles.length ? 'awaitingUserApproval' : 'autoAccepted';
  return {
    proposalId: actionBundle.id ?? 'bundle-generic',
    status,
    requiredPermissions: permissionBundles.map((bundle) => bundle.capability),
    diagnostics: [],
    executionContract: {
      id: contractId,
      proposalId: actionBundle.id ?? 'bundle-generic',
      status,
      catalogVersion: 'deepcode.kernel.tools.v3',
      catalogHash: 'test-catalog-hash',
      operationSetHash: 'test-operation-set-hash',
      contractHash: `hash-${contractId}`,
      operations: actions.map((action) => ({
        id: action.actionId,
        title: action.description ?? action.actionId,
        toolId: action.toolId,
        operationKind: testKernelOperationKindForToolId(action.toolId),
        args: action.args ?? {},
        argsHash: `hash-${action.actionId}`,
        readSet: [],
        writeSet: typeof action.args?.path === 'string' ? [action.args.path] : [],
        conflictKeys: typeof action.args?.path === 'string' ? [action.args.path] : [],
        executionMode: 'execute',
        cleanup: {
          leasePolicy: 'none',
          terminateProcessTree: false,
          removeScratch: false,
          revokeBrokerGrant: false,
          deadlineMs: 0,
          failurePolicy: 'blockReviewAcceptance',
        },
      })),
      permissionBundles,
      interventions: permissionBundles.map((bundle) => ({
        id: `gate-${bundle.id}`,
        interventionKind: 'permission',
        status: 'pending',
        permissionBundleId: bundle.id,
        affectedOperationIds: bundle.operationIds,
        summary: 'Kernel permission gate.',
      })),
      cleanupPolicy: 'perOperationCleanupContract',
      expiresAfter: 'reviewGateOrRunTerminal',
    },
  };
}

function testKernelOperationKindForToolId(toolId: string): KernelProposalReviewReport['executionContract']['operations'][number]['operationKind'] {
  const operationKinds: Record<string, KernelProposalReviewReport['executionContract']['operations'][number]['operationKind']> = {
    'fs.read': 'fsRead',
    'fs.list': 'fsList',
    'fs.glob': 'fsGlob',
    'code.grep': 'codeGrep',
    'fs.diff': 'fsDiff',
    'fs.create': 'fsCreate',
    'fs.write': 'fsWrite',
    'fs.edit': 'fsEdit',
    'fs.rename': 'fsRename',
    'fs.delete': 'fsDelete',
    'document.read': 'documentRead',
    'git.status': 'gitStatus',
    'git.diff': 'gitDiff',
    'git.stage': 'gitStage',
    'git.unstage': 'gitUnstage',
    'git.commit': 'gitCommit',
    'git.push': 'gitPush',
    'web.search': 'webSearch',
    'web.fetch': 'webFetch',
    'process.exec': 'processExec',
    'provider.call': 'providerCall',
  };
  const operationKind = operationKinds[toolId];
  if (!operationKind) throw new Error(`Test ToolContract is missing operationKind for ${toolId}.`);
  return operationKind;
}

function testKernelCapabilityForToolId(toolId: string): string | undefined {
  if (['fs.read', 'fs.list', 'fs.glob', 'fs.diff', 'code.grep', 'document.read'].includes(toolId)) return 'workspace.read';
  if (['fs.create', 'fs.write', 'fs.edit', 'fs.rename', 'fs.delete'].includes(toolId)) return 'workspace.write';
  if (['git.status', 'git.diff'].includes(toolId)) return 'git.read';
  if (['git.stage', 'git.unstage', 'git.commit'].includes(toolId)) return 'git.write';
  if (toolId === 'git.push') return 'git.push';
  if (['web.search', 'web.fetch'].includes(toolId)) return 'network.egress';
  if (toolId === 'process.exec') return 'process.exec';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return undefined;
}

function testKernelPermissionModeForToolId(toolId: string): 'allow' | 'ask' {
  return ['fs.read', 'fs.list', 'fs.glob', 'fs.diff', 'code.grep', 'document.read', 'git.status', 'git.diff'].includes(toolId)
    ? 'allow'
    : 'ask';
}

function testKernelPermissionResourceKind(
  capability: string
): KernelProposalReviewReport['executionContract']['permissionBundles'][number]['resourceKind'] {
  if (capability === 'workspace.write' || capability === 'workspace.read') return 'workspacePath';
  if (capability === 'git.read' || capability === 'git.write' || capability === 'git.push') return 'gitWorkspace';
  if (capability === 'process.exec') return 'process';
  if (capability === 'network.egress') return 'networkTarget';
  if (capability === 'browser.control') return 'browserState';
  if (capability === 'provider.egress') return 'providerProfile';
  return 'runtimePermission';
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
      : Array.isArray(item.toolIds) && typeof item.toolIds[0] === 'string'
        ? item.toolIds[0]
        : 'fs.write';
    scopes.push({
      scopeKind: typeof item.scopeKind === 'string' ? item.scopeKind : 'workspaceModule',
      path,
      capability,
      operations: Array.isArray(item.operations) ? item.operations : (capability === 'fs.edit' ? ['patch'] : ['create', 'write']),
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
  if (capability === 'fs.edit') return 'write';
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
        actionId: 'read-generic',
        toolId: 'fs.read',
        args: { path: 'generic/input.txt' },
        description: 'Read generic resource',
      },
      {
        actionId: 'write-generic',
        toolId: 'fs.write',
        args: { path: 'generic/output.txt', contentBlockId: 'code-generic' },
        description: 'Write generic resource',
      },
    ],
    validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
    reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
  };
}

export function acceptedTaskPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event: AgentEvent = {
    id: `event-${runId}-implementation-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId: 'impl-generic-auto',
      planHash: 'plan-hash-impl-generic-auto',
      title: 'Generic implementation plan',
      summary: 'Implement a generic workspace file update.',
      status: 'pending',
      confirmable: true,
      taskPlan: {
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
            toolId: 'fs.write',
            args: {},
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
      contentBlocks: [],
      commandBlocks: [],
    },
  };
  return applyKernelPlanAuthorizationFixture(event);
}

export function applyKernelPlanAuthorizationFixture(event: AgentEvent): AgentEvent {
  const payload = event.payload as Record<string, any>;
  const taskPlan = payload.taskPlan as Record<string, any> | undefined;
  const planId = String(payload.planId ?? taskPlan?.id ?? 'plan-generic');
  const planHash = `plan-hash-${planId}`;
  const tasks = Array.isArray(taskPlan?.tasks) ? taskPlan.tasks as Array<Record<string, any>> : [];
  const catalogTools = ((genericToolCatalogSnapshot().tools as Array<Record<string, any>> | undefined) ?? []);
  const operations = tasks.flatMap((task, taskIndex) => {
    const toolId = String(task.toolId ?? task.fileOperations?.[0]?.toolId ?? task.fileOperations?.[0]?.capability ?? '').trim();
    const targets = Array.isArray(task.target)
      ? task.target.map((target: unknown) => String(target).trim()).filter(Boolean)
      : [];
    if (!toolId || targets.length === 0) return [];
    const contract = catalogTools.find((tool) => tool.toolId === toolId);
    const operationKind = String(contract?.operationKind ?? '').trim();
    const contentMode = String(contract?.usageConstraints?.contentMode ?? 'none').trim();
    const targetKinds = Array.isArray(task.targetResourceKinds)
      ? task.targetResourceKinds.map((value: unknown) => String(value).trim())
      : [];
    const sourceTaskId = String(task.taskId ?? `task-${taskIndex + 1}`);
    const fixedArgs = task.args && typeof task.args === 'object' && !Array.isArray(task.args)
      ? { ...task.args }
      : {};
    const mutating = ['fs.create', 'fs.write', 'fs.edit', 'fs.rename', 'fs.delete'].includes(toolId);
    return targets.map((target: string, targetIndex: number) => {
      const targetResourceKind = targetKinds[targetIndex] || (toolId === 'fs.delete' ? 'file' : undefined);
      const argsTemplate: Record<string, unknown> = { path: target };
      if (contentMode === 'contentBlock') argsTemplate.contentBlockId = 'executionTime';
      if (contentMode === 'replacementBlock') argsTemplate.replacementBlockId = 'executionTime';
      if (toolId === 'fs.delete' && targetResourceKind) {
        argsTemplate.targetKind = targetResourceKind;
        argsTemplate.recursive = targetResourceKind === 'directory';
      }
      return {
        id: `plan-op-${sourceTaskId}-${targetIndex + 1}`,
        sourceTaskId,
        toolId,
        operationKind,
        contentMode,
        targets: [target],
        dependsOn: Array.isArray(task.dependencies) ? [...task.dependencies] : [],
        fixedArgs,
        argsTemplate,
        targetKind: targetResourceKind,
        recursive: targetResourceKind === 'directory',
        readSet: mutating ? [] : [target],
        writeSet: mutating ? [target] : [],
        conflictKeys: [`workspace:${target}`],
        executionMode: 'execute',
        internal: false,
      };
    });
  });
  const writeOperations = operations.filter((operation) => operation.writeSet.length > 0);
  const permissionBundles = writeOperations.length > 0 ? [{
    id: `permission-bundle-${planId}`,
    capability: 'workspace.write',
    permissionMode: 'ask',
    risk: 'medium',
    resourceKind: 'workspace',
    operationIds: writeOperations.map((operation) => operation.id),
    toolIds: [...new Set(writeOperations.map((operation) => operation.toolId))],
    targets: [...new Set(writeOperations.flatMap((operation) => operation.targets))],
    expiresAfter: 'reviewGateReplanCancelOrRunTerminal',
  }] : [];
  const authorizationContract = {
    id: `plan-authorization-${planId}`,
    planId,
    planHash,
    status: 'confirmable',
    catalogVersion: 'deepcode.kernel.tools.v3',
    catalogHash: 'test-tool-catalog',
    operationSetHash: `operation-set-${planId}`,
    contractHash: `plan-authorization-hash-${planId}`,
    operations,
    permissionBundles,
    interventions: [],
    cleanupPolicy: 'kernelPlanGrantLease',
    expiresAfter: 'reviewGateReplanCancelOrRunTerminal',
  };
  payload.planId = planId;
  payload.planHash = planHash;
  payload.authorizationContract = authorizationContract;
  payload.planAuthorizationReview = {
    planId,
    status: 'confirmable',
    diagnostics: [],
    authorizationContract,
  };
  return event;
}

export function genericKernelContextProjectionEvent(sessionId: string, runId: string): AgentEvent {
  return {
    id: `event-${runId}-kernel-context`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'workflow_stage',
    payload: {
      runId,
      kernelEvent: {
        kind: 'state.entered',
        runId,
        sessionId,
        stateContract: {
          runId,
          sessionId,
          stateId: 'needProposal',
          stateKind: 'driverRequest',
          allowedInputs: ['proposalSubmit', 'resourceResolve'],
          allowedProposals: ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'actionBundle', 'diagnostic'],
          proposalSchemaRefs: ['deepcode.agent.protocol.v4'],
          capabilityProjection: ['fs.read', 'fs.list', 'fs.write'],
          toolCatalogSnapshot: genericToolCatalogSnapshot(),
          draftAdmissionPolicy: { maxTotalUtf8Bytes: 384 * 1024 },
        },
      },
    },
  };
}

export function genericResolvedResourceEvent(
  sessionId: string,
  runId: string,
  path: string,
  kind: 'file' | 'directory' = 'file'
): AgentEvent {
  return {
    id: `event-${runId}-resource-${randomSmokeToken('resource')}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    payload: {
      runId,
      toolName: 'kernel.resourceResolve',
      status: 'ok',
      output: {
        id: `packet-${randomSmokeToken('packet')}`,
        workspaceScopeKey: `workspace-${randomSmokeToken('scope')}`,
        requestId: `request-${randomSmokeToken('request')}`,
        items: [{
          requestItemId: `item-${randomSmokeToken('item')}`,
          manifestEntryId: `entry-${randomSmokeToken('entry')}`,
          readPolicy: 'autoRead',
          status: 'resolved',
          path,
          resolvedKind: kind,
          contentKind: kind === 'directory' ? 'directoryTree' : 'fileText',
          promptContent: kind === 'directory' ? `${path}/` : `resolved content for ${path}`,
          rangeComplete: true,
          evidenceRefs: ['genericResourceEvidence'],
        }],
      },
    },
  };
}

export function genericMissingResourceEvent(
  sessionId: string,
  runId: string,
  path: string
): AgentEvent {
  return {
    id: `event-${runId}-missing-resource-${randomSmokeToken('resource')}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'tool_result',
    payload: {
      runId,
      toolName: 'kernel.resourceResolve',
      status: 'ok',
      output: {
        id: `packet-${randomSmokeToken('packet')}`,
        workspaceScopeKey: `workspace-${randomSmokeToken('scope')}`,
        requestId: `request-${randomSmokeToken('request')}`,
        items: [{
          requestItemId: `item-${randomSmokeToken('item')}`,
          manifestEntryId: `entry-${randomSmokeToken('entry')}`,
          readPolicy: 'autoRead',
          status: 'error',
          reason: 'not_found',
          path,
          rangeComplete: true,
          evidenceRefs: ['genericMissingResourceEvidence'],
        }],
      },
    },
  };
}

export function readOnlyAcceptedTaskPlanCardEvent(
  sessionId: string,
  runId: string,
  token: string,
  targets: string[]
): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = `impl-${token}`;
  payload.taskPlan.id = `impl-${token}`;
  payload.taskPlan.title = 'Random read-only validation plan';
  payload.taskPlan.summary = 'Resolve current evidence for accepted read-only targets.';
  payload.taskPlan.tasks = [
    {
      taskId: `task-${token}-read`,
      title: 'Validate random accepted targets',
      target: targets,
      scope: 'Resolve current read-only evidence for the accepted targets.',
      dependencies: [],
      toolId: 'fs.read',
      args: {},
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
  return applyKernelPlanAuthorizationFixture(event);
}

export function generatedArtifactAcceptedTaskPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generated-artifact';
  payload.taskPlan.id = 'impl-generated-artifact';
  payload.taskPlan.title = 'Generic generated artifact implementation plan';
  payload.taskPlan.summary = 'Write one file, then read it as current evidence for a dependent write.';
  payload.taskPlan.tasks = [
    {
      taskId: 'task-generated-input',
      title: 'Write generated input',
      target: ['generic-generated/input.txt'],
      scope: 'Create a generic input artifact inside the accepted workspace scope.',
      dependencies: [],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the generated input write fact.'],
      failureCriteria: ['Stop if the write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generated-output',
      title: 'Write generated output',
      target: ['generic-generated/output.txt'],
      scope: 'Read the generated input evidence, then create a dependent output artifact.',
      dependencies: ['task-generated-input'],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the generated output write fact.'],
      failureCriteria: ['Stop if the generated input evidence cannot be resolved.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
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

export function multiTargetAcceptedTaskPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-multi';
  payload.taskPlan.id = 'impl-generic-multi';
  payload.taskPlan.tasks = [
    {
      taskId: 'task-generic-one',
      title: 'Write generic file one',
      target: ['generic-one.txt'],
      scope: 'Write the first generic file.',
      dependencies: [],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the first generic write fact.'],
      failureCriteria: ['Stop if the first write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generic-two',
      title: 'Write generic file two',
      target: ['generic-two.txt'],
      scope: 'Write the second generic file.',
      dependencies: ['task-generic-one'],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the second generic write fact.'],
      failureCriteria: ['Stop if the second write leaves the accepted target scope.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function tripleTargetAcceptedTaskPlanCardEvent(sessionId: string, runId: string, token: string): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = `impl-${token}`;
  payload.taskPlan.id = `impl-${token}`;
  payload.taskPlan.title = 'Generic ordered implementation plan';
  payload.taskPlan.summary = 'Write three generic targets in accepted task order.';
  payload.taskPlan.tasks = [
    {
      taskId: `task-${token}-one`,
      title: 'Write first generic target',
      target: [`generic-${token}-one.txt`],
      scope: 'Write the first accepted generic target.',
      dependencies: [],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the first generic write fact.'],
      failureCriteria: ['Stop if the first write leaves the accepted target scope.'],
    },
    {
      taskId: `task-${token}-two`,
      title: 'Write second generic target',
      target: [`generic-${token}-two.txt`],
      scope: 'Write the second accepted generic target.',
      dependencies: [`task-${token}-one`],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the second generic write fact.'],
      failureCriteria: ['Stop if the second write leaves the accepted target scope.'],
    },
    {
      taskId: `task-${token}-three`,
      title: 'Write third generic target',
      target: [`generic-${token}-three.txt`],
      scope: 'Write the third accepted generic target.',
      dependencies: [`task-${token}-two`],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records the third generic write fact.'],
      failureCriteria: ['Stop if the third write leaves the accepted target scope.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function commaSeparatedTargetsAcceptedTaskPlanCardEvent(sessionId: string, runId: string, paths: string[]): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-random-comma';
  payload.taskPlan.id = 'impl-random-comma';
  payload.taskPlan.title = 'Random multi-target implementation plan';
  payload.taskPlan.summary = 'Write all accepted random targets as one reviewed execution batch.';
  payload.taskPlan.tasks = [
    {
      taskId: 'task-random-comma-targets',
      title: 'Write random accepted targets',
      target: [paths.join(', ')],
      scope: 'The task target field intentionally carries several concrete file targets in one path-list string.',
      dependencies: [],
      toolId: 'fs.write',
      args: {},
      acceptanceCriteria: ['Kernel records write work unit facts for every accepted target.'],
      failureCriteria: ['Stop if any action leaves the accepted target scope.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function independentMultiTargetAcceptedTaskPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-independent';
  payload.taskPlan.id = 'impl-generic-independent';
  for (const task of payload.taskPlan.tasks ?? []) {
    task.dependencies = [];
  }
  return applyKernelPlanAuthorizationFixture(event);
}

export function deleteAcceptedTaskPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-delete';
  payload.taskPlan.id = 'impl-generic-delete';
  payload.taskPlan.title = 'Generic delete implementation plan';
  payload.taskPlan.summary = 'Remove one generic obsolete workspace file.';
  payload.taskPlan.tasks = [
    {
      taskId: 'task-generic-delete',
      title: 'Delete generic obsolete file',
      target: ['generic-obsolete.txt'],
      scope: 'Delete a generic obsolete file inside the accepted workspace scope.',
      dependencies: [],
      toolId: 'fs.delete',
      args: {},
      acceptanceCriteria: ['Kernel records the delete work unit fact for the generic obsolete file.'],
      failureCriteria: ['Stop if the delete target is empty, root, absolute, or outside the accepted target scope.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function multiDeleteAcceptedTaskPlanCardEvent(
  sessionId: string,
  runId: string,
  token: string,
  targets: string[],
  targetResourceKinds?: Array<'file' | 'directory'>
): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = `impl-${token}`;
  payload.taskPlan.id = `impl-${token}`;
  payload.taskPlan.title = 'Generic multi-delete implementation plan';
  payload.taskPlan.summary = 'Remove several accepted cleanup targets in one current task batch.';
  payload.taskPlan.tasks = [
    {
      taskId: `task-${token}`,
      title: 'Delete accepted cleanup targets',
      target: targets,
      targetResourceKinds,
      scope: 'Delete only the accepted cleanup targets listed by this task.',
      dependencies: [],
      toolId: 'fs.delete',
      args: {},
      acceptanceCriteria: ['Kernel records delete work unit facts for every accepted cleanup target.'],
      failureCriteria: ['Stop if any delete action leaves the accepted target scope.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function directoryDeleteAcceptedTaskPlanCardEvent(
  sessionId: string,
  runId: string,
  dirPath: string,
  childNames: string[]
): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  const planId = `impl-${dirPath.replace(/[^A-Za-z0-9_.-]+/g, '-')}`;
  payload.planId = planId;
  payload.taskPlan.id = planId;
  payload.taskPlan.title = 'Generic directory delete implementation plan';
  payload.taskPlan.summary = 'Remove one accepted directory as a single current-task delete.';
  payload.taskPlan.tasks = [
    {
      taskId: `task-${dirPath.replace(/[^A-Za-z0-9_.-]+/g, '-')}`,
      title: 'Delete accepted directory target',
      target: [dirPath],
      targetResourceKinds: ['directory'],
      scope: `Delete the accepted directory target; observed children: ${childNames.join(', ')}.`,
      dependencies: [],
      toolId: 'fs.delete',
      args: {},
      acceptanceCriteria: ['Kernel records a directory delete work unit fact for the accepted target.'],
      failureCriteria: ['Stop if the delete target leaves the accepted directory target scope.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function singleTargetWriteProposal(targetPath: string, contentSuffix: string): Record<string, unknown> {
  const blockId = `code-${contentSuffix}`;
  const actionId = `write-${contentSuffix}`;
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlanMarkdown: [
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
      '- The target belongs to the accepted taskPlan file scope.',
    ].join('\n'),
    contentBlocks: [
      { blockId, targetPath, operation: 'overwrite', contentLines: [`generic ${contentSuffix}`] },
    ],
    actionBundle: {
      version: '1',
      id: `bundle-${contentSuffix}`,
      goal: `Write ${targetPath}.`,
      actions: [{
        actionId,
        toolId: 'fs.write',
        args: { path: targetPath, contentBlockId: blockId },
        description: `Write ${targetPath}`,
      }],
      validationExpectations: [{ id: `validation-${contentSuffix}`, description: `Kernel records ${targetPath}.` }],
      reviewExpectations: [{ id: `review-${contentSuffix}`, description: `Review ${targetPath}.` }],
    },
  };
}
export function genericDiagnosticProposal(summary: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
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

export function processExecAcceptedTaskPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedTaskPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-exec';
  payload.taskPlan.id = 'impl-generic-exec';
  payload.taskPlan.tasks = [
    {
      taskId: 'task-generic-exec',
      title: 'Run generic validation',
      target: ['scripts/validate.sh'],
      scope: 'Run a generic validation command described by the accepted plan.',
      dependencies: [],
      toolId: 'process.exec',
      args: {},
      acceptanceCriteria: ['Kernel permission gate owns the process execution decision.'],
      failureCriteria: ['Stop if Session asks for a new technical plan instead of using Kernel PermissionGate.'],
    },
  ];
  return applyKernelPlanAuthorizationFixture(event);
}

export function multiWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.contentBlocks = [
    { blockId: 'code-one', targetPath: 'generic-one.txt', operation: 'overwrite', contentLines: ['one'] },
    { blockId: 'code-two', targetPath: 'generic-two.txt', operation: 'overwrite', contentLines: ['two'] },
  ];
  proposal.actionBundle = multiWriteActionBundle();
  return proposal;
}

export function randomMultiWriteProposal(paths: string[], options?: { briefUserPlan?: boolean }): Record<string, unknown> {
  const token = randomSmokeToken('bundle');
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlanMarkdown: options?.briefUserPlan
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
    contentBlocks: paths.map((path, index) => ({
      blockId: `code-${token}-${index}`,
      targetPath: path,
      operation: 'overwrite',
      contentLines: [`content ${randomSmokeToken('content')}`],
    })),
    actionBundle: {
      version: '1',
      id: `bundle-${token}`,
      goal: 'Write accepted random target files.',
      actions: paths.map((path, index) => ({
        actionId: `write-${token}-${index}`,
        toolId: 'fs.write',
        args: { path, contentBlockId: `code-${token}-${index}` },
        description: `Write ${path}`,
      })),
      validationExpectations: [{ id: `validation-${token}`, description: 'Kernel records write work unit facts for all target paths.' }],
      reviewExpectations: [{ id: `review-${token}`, description: 'User reviews the generated target files and Kernel facts.' }],
    },
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
        args: { path: 'generic-one.txt', contentBlockId: 'code-one' },
        description: 'Write generic file one.',
      },
      {
        actionId: 'write-generic-two',
        toolId: 'fs.write',
        args: { path: 'generic-two.txt', contentBlockId: 'code-two' },
        description: 'Write generic file two.',
      },
    ],
    validationExpectations: [{ id: 'validation-multi', description: 'Kernel records file write facts.' }],
    reviewExpectations: [{ id: 'review-multi', description: 'User reviews all written files.' }],
  };
}

export function processExecProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v4',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlanMarkdown: [
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
  };
}

export function fakeKernel(request: KernelCommandEnvelope): KernelReply {
  const command = request.command;
  if (command.kind === 'runCreate') {
    const toolCatalogSnapshot = genericToolCatalogSnapshot();
    const runId = 'run-generic';
    const sessionId = command.sessionId ?? 'session-generic';
    return {
      ok: true,
      events: [
        {
          kind: 'state.entered',
          runId,
          sessionId,
          stateContract: {
            runId,
            stateId: 'needProposal',
            stateKind: 'driverRequest',
            allowedInputs: ['proposalSubmit', 'resourceResolve'],
            allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
            proposalSchemaRefs: ['deepcode.agent.protocol.v4'],
            capabilityProjection: ['fs.read', 'fs.write'],
            toolCatalogSnapshot,
            draftAdmissionPolicy: { maxTotalUtf8Bytes: 384 * 1024 },
          },
        },
        {
          kind: 'driver.request_produced',
          runId,
          sessionId,
          driverRequest: {
            id: 'driver-generic',
            runId,
            sessionId,
            kind: 'needProposal',
            reason: 'Need a v3 proposal.',
            stateContract: {
              runId,
              stateId: 'needProposal',
              stateKind: 'driverRequest',
              allowedInputs: ['proposalSubmit', 'resourceResolve'],
              allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
              proposalSchemaRefs: ['deepcode.agent.protocol.v4'],
              capabilityProjection: ['fs.read', 'fs.write'],
              toolCatalogSnapshot,
              draftAdmissionPolicy: { maxTotalUtf8Bytes: 384 * 1024 },
            },
          },
        },
      ],
    };
  }
  if (command.kind === 'planAuthorizationSubmit') {
    const intent = command.intent as Record<string, any>;
    const tasks = Array.isArray(intent?.tasks) ? intent.tasks as Array<Record<string, any>> : [];
    const toolCatalogSnapshot = genericToolCatalogSnapshot();
    const catalogTools = Array.isArray(toolCatalogSnapshot.tools)
      ? toolCatalogSnapshot.tools as Array<Record<string, any>>
      : [];
    const operations: KernelPlanAuthorizationContract['operations'] = tasks.flatMap((task, taskIndex) => {
      const toolId = String(task.toolId ?? '').trim();
      const targets = Array.isArray(task.targets)
        ? task.targets.map((target: unknown) => String(target).trim()).filter(Boolean)
        : [];
      if (!toolId || targets.length === 0) return [];
      const contract = catalogTools.find((tool) => tool.toolId === toolId);
      const operationKind = testKernelOperationKindForToolId(toolId);
      const contentMode = contract?.usageConstraints && typeof contract.usageConstraints === 'object' && !Array.isArray(contract.usageConstraints)
        ? String((contract.usageConstraints as Record<string, unknown>).contentMode ?? 'none') as KernelPlanAuthorizationContract['operations'][number]['contentMode']
        : 'none';
      const sourceTaskId = String(task.taskId ?? `task-${taskIndex + 1}`);
      const fixedArgs = task.args && typeof task.args === 'object' && !Array.isArray(task.args)
        ? { ...task.args }
        : {};
      const mutating = ['fs.create', 'fs.write', 'fs.edit', 'fs.rename', 'fs.delete'].includes(toolId);
      return targets.map((target: string, targetIndex: number) => {
        const targetResourceKind = toolId === 'fs.delete' ? 'file' as const : undefined;
        const argsTemplate: Record<string, unknown> = { path: target };
        if (contentMode === 'contentBlock') argsTemplate.contentBlockId = 'executionTime';
        if (contentMode === 'replacementBlock') argsTemplate.replacementBlockId = 'executionTime';
        if (targetResourceKind) {
          argsTemplate.targetKind = targetResourceKind;
          argsTemplate.recursive = false;
        }
        return {
          id: `plan-op-${sourceTaskId}-${targetIndex + 1}`,
          sourceTaskId,
          toolId,
          operationKind,
          contentMode,
          targets: [target],
          dependsOn: Array.isArray(task.dependencies) ? [...task.dependencies] : [],
          fixedArgs,
          argsTemplate,
          targetKind: targetResourceKind,
          recursive: false,
          readSet: mutating ? [] : [target],
          writeSet: mutating ? [target] : [],
          conflictKeys: [`workspace:${target}`],
          executionMode: 'execute' as const,
          internal: false,
        };
      });
    });
    const writeOperations = operations.filter((operation) => operation.writeSet.length > 0);
    const permissionBundles: KernelPlanAuthorizationContract['permissionBundles'] = writeOperations.length > 0 ? [{
      id: `permission-bundle-${intent.planId}`,
      capability: 'workspace.write',
      permissionMode: 'ask',
      risk: 'medium',
      resourceKind: 'workspacePath',
      operationIds: writeOperations.map((operation) => operation.id),
      toolIds: [...new Set(writeOperations.map((operation) => operation.toolId))],
      targets: [...new Set(writeOperations.flatMap((operation) => operation.targets))],
      expiresAfter: 'reviewGateReplanCancelOrRunTerminal',
    }] : [];
    const authorizationContract: KernelPlanAuthorizationContract = {
      id: `plan-authorization-${intent.planId}`,
      planId: intent.planId,
      planHash: intent.planHash,
      status: 'confirmable',
      workspaceBindingHash: intent.workspaceBindingHash,
      catalogVersion: intent.catalogVersion,
      catalogHash: intent.catalogHash,
      operationSetHash: `operation-set-${intent.planId}`,
      contractHash: `plan-authorization-hash-${intent.planId}`,
      operations,
      permissionBundles,
      interventions: [],
      cleanupPolicy: 'planGrantLease',
      expiresAfter: 'reviewGateReplanCancelOrRunTerminal',
    };
    return {
      ok: true,
      events: [{
        kind: 'plan_authorization.reviewed',
        runId: command.runId,
        sessionId: command.sessionId,
        planId: intent.planId,
        review: {
          planId: intent.planId,
          status: 'confirmable',
          diagnostics: [],
          authorizationContract,
        },
      }],
    };
  }
  if (command.kind === 'resourceResolve') {
    const manifest = recordValue(command.request.manifest);
    const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
    const entry = recordValue(entries[0]) ?? {};
    return {
      ok: true,
      events: [
        {
          kind: 'resource.packet_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          packet: {
            id: `packet-${command.requestId ?? 'generic'}`,
            requestId: command.requestId,
            workspaceScopeKey: 'workspace-scope-generic',
            manifestId: String(manifest?.id ?? 'manifest-generic'),
            evidenceRefs: ['evidence-generic'],
            summary: 'Resolved one generic test resource.',
            items: [
              {
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                rootId: entry.rootId,
                path: entry.path ?? entry.resourceRef,
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
  if (command.kind === 'planAuthorizationDecisionSubmit') {
    return {
      ok: true,
      events: [{
        kind: 'plan_authorization.decision_recorded',
        runId: command.runId,
        sessionId: command.sessionId,
        authorizationContractId: command.decision?.authorizationContractId,
        decision: command.decision?.decision,
        leaseId: command.decision?.decision === 'accept'
          ? `plan-grant-lease-${command.decision?.planId ?? 'generic'}`
          : undefined,
      }],
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
    planTargetMode: 'perTarget',
    needsWorkspace: true,
    readOnly: true,
    usageConstraints: {
      targetExistence: 'any',
      targetKinds: [],
      contentMode: 'none',
      directoryRecursiveRequired: false,
    },
  };
  return {
    catalogVersion: 'test-v1',
    catalogHash: 'test-tool-catalog',
    tools: [
      {
        ...base,
        toolId: 'fs.read',
        capability: 'fs.read',
        operationKind: 'fsRead',
        usageConstraints: {
          targetExistence: 'mustExist',
          targetKinds: ['file'],
          contentMode: 'none',
          directoryRecursiveRequired: false,
        },
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
        operationKind: 'fsList',
        usageConstraints: {
          targetExistence: 'mustExist',
          targetKinds: ['directory'],
          contentMode: 'none',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        ...base,
        toolId: 'fs.create',
        capability: 'fs.write',
        operationKind: 'fsCreate',
        permissionMode: 'ask',
        readOnly: false,
        usageConstraints: {
          targetExistence: 'mustNotExist',
          targetKinds: ['file'],
          contentMode: 'contentBlock',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, contentBlockId: { type: 'string' } },
          required: ['path', 'contentBlockId'],
        },
      },
      {
        ...base,
        toolId: 'fs.write',
        capability: 'fs.write',
        operationKind: 'fsWrite',
        permissionMode: 'ask',
        readOnly: false,
        usageConstraints: {
          targetExistence: 'mustExist',
          targetKinds: ['file'],
          contentMode: 'contentBlock',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, contentBlockId: { type: 'string' } },
          required: ['path', 'contentBlockId'],
        },
      },
      {
        ...base,
        toolId: 'fs.edit',
        capability: 'fs.write',
        operationKind: 'fsEdit',
        permissionMode: 'ask',
        readOnly: false,
        usageConstraints: {
          targetExistence: 'mustExist',
          targetKinds: ['file'],
          contentMode: 'replacementBlock',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            replacementBlockId: { type: 'string' },
            patchSpec: { type: 'object' },
          },
          required: ['path', 'replacementBlockId', 'patchSpec'],
        },
      },
      {
        ...base,
        toolId: 'fs.delete',
        capability: 'fs.write',
        operationKind: 'fsDelete',
        permissionMode: 'ask',
        risk: 'high',
        readOnly: false,
        usageConstraints: {
          targetExistence: 'mustExist',
          targetKinds: ['file', 'directory'],
          contentMode: 'none',
          directoryRecursiveRequired: true,
        },
        providerSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            targetKind: { type: 'string', enum: ['file', 'directory'] },
            recursive: { type: 'boolean' },
          },
          required: ['path'],
        },
      },
      {
        ...base,
        toolId: 'process.exec',
        capability: 'process.exec',
        family: 'process',
        operationKind: 'processExec',
        executionMode: 'blocked',
        permissionMode: 'deny',
        pathScopePolicy: 'none',
        needsWorkspace: false,
        readOnly: false,
        risk: 'high',
        usageConstraints: {
          targetExistence: 'any',
          targetKinds: [],
          contentMode: 'none',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: { argv: { type: 'array', items: { type: 'string' } } },
          required: ['argv'],
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
        content: '',
        toolCalls: [{
          id: 'generic-submit-answer',
          name: 'session.submit_answer',
          arguments: {
            content: 'The attached generic resource was resolved through Kernel ResourceResolve.',
          },
        }],
      },
    },
  };
}

function recordValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

export interface KernelTestWorkUnitInput {
  runId: string;
  workUnitId: string;
  actionId: string;
  toolId?: string;
  operationKind?: KernelToolOperationKind;
  planId?: string;
  readSet?: string[];
  writeSet?: string[];
  status?: KernelWorkUnitDescriptor['status'];
}

export function kernelTestWorkUnit(input: KernelTestWorkUnitInput): KernelWorkUnitDescriptor {
  const toolId = input.toolId ?? 'fs.create';
  return {
    id: input.workUnitId,
    planId: input.planId ?? `plan-${input.runId}`,
    actionId: input.actionId,
    title: input.actionId,
    toolId,
    operationKind: input.operationKind ?? operationKindForTestTool(toolId),
    capability: toolId.startsWith('git.') ? 'git.write' : 'fs.write',
    readSet: input.readSet ?? [],
    writeSet: input.writeSet ?? [],
    conflictKeys: [...(input.writeSet ?? [])],
    executionMode: 'execute',
    status: input.status ?? 'queued',
  };
}

export function kernelTestWorkUnitQueued(input: KernelTestWorkUnitInput): KernelEventV1 {
  return {
    kind: 'work_unit.queued',
    runId: input.runId,
    workUnit: kernelTestWorkUnit({ ...input, status: 'queued' }),
  };
}

export function kernelTestWorkUnitStarted(runId: string, workUnitId: string): KernelEventV1 {
  return { kind: 'work_unit.started', runId, workUnitId };
}

export function kernelTestWorkUnitCompleted(runId: string, workUnitId: string, output?: unknown): KernelEventV1 {
  return { kind: 'work_unit.completed', runId, workUnitId, ...(output === undefined ? {} : { output }) };
}

export function kernelTestWorkUnitFailed(
  runId: string,
  workUnitId: string,
  code: string,
  message: string,
): KernelEventV1 {
  return {
    kind: 'work_unit.failed',
    runId,
    workUnitId,
    error: { code, message },
  };
}

export function kernelTestBatchReviewReady(runId: string, contractId = `contract-${runId}`): KernelEventV1 {
  return { kind: 'batch.review_ready', runId, contractId };
}

export function kernelTestPermissionRequest(
  id: string,
  overrides: Partial<KernelPermissionRequestEnvelope> = {},
): KernelPermissionRequestEnvelope {
  return {
    id,
    requestKind: 'runtimePermission',
    affectedOperationIds: [],
    workUnitIds: [],
    capability: 'fs.write',
    riskLevel: 'medium',
    summary: 'Kernel test permission request.',
    argsPreview: {},
    ...overrides,
  };
}

export function kernelTestResourcePacket(
  id: string,
  requestId: string,
  items: KernelResourcePacket['items'],
  workspaceScopeKey = 'workspace-smoke',
): KernelResourcePacket {
  return {
    id,
    requestId,
    workspaceScopeKey,
    manifestId: `manifest-${requestId}`,
    items,
    evidenceRefs: items.flatMap((item) => item.evidenceRefs ?? []),
    summary: `Resolved ${items.length} resource item(s).`,
  };
}

export function kernelTestReviewFacts(runId: string, factsRef = `facts-${runId}`): KernelReviewFacts {
  return {
    factsRef,
    runId,
    eventCount: 0,
    workUnits: [],
    queuedWorkUnits: [],
    startedWorkUnits: [],
    completedWorkUnits: [],
    failedWorkUnits: [],
    blockedWorkUnits: [],
    awaitingPermissions: [],
    toolResults: [],
    gitFacts: [],
    writtenFiles: [],
    createdFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    patchChangedRanges: [],
    generatedArtifacts: [],
    resourceEvents: [],
    cleanupFailures: [],
    pathNormalizationDiagnostics: [],
    batchReviewReady: true,
  };
}

function operationKindForTestTool(toolId: string): KernelToolOperationKind {
  const operationKinds: Record<string, KernelToolOperationKind> = {
    'fs.read': 'fsRead',
    'fs.list': 'fsList',
    'fs.glob': 'fsGlob',
    'fs.diff': 'fsDiff',
    'fs.create': 'fsCreate',
    'fs.write': 'fsWrite',
    'fs.edit': 'fsEdit',
    'fs.rename': 'fsRename',
    'fs.delete': 'fsDelete',
    'code.grep': 'codeGrep',
  };
  const operationKind = operationKinds[toolId];
  if (!operationKind) {
    throw new Error(`Unsupported test toolId: ${toolId}`);
  }
  return operationKind;
}
