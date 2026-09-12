import {
  CONVERSATION_COMMAND_VERSION,
  type ActivityProjection,
  type PlanProjection,
  type PresentationBlock,
  type PresentationSourceIdentity,
  type ProjectionMessage,
  type SessionProjection,
} from '@deepcode/protocol';

function source(
  kind: PresentationSourceIdentity['kind'],
  id: string,
  sequence?: number,
): PresentationSourceIdentity {
  return sequence === undefined ? { kind, id } : { kind, id, sequence };
}

function messageBlock(message: ProjectionMessage): PresentationBlock {
  const identity = source('message', message.messageId, message.sequence);
  const text: PresentationBlock = {
    kind: 'text',
    blockId: `message:${message.messageId}:content`,
    source: identity,
    region: 'timeline',
    text: message.content,
    format: message.role === 'assistant' ? 'markdown' : 'plain',
    role: message.role,
  };
  const referenceEntries = message.filesystemReferences.map((reference) => ({
    key: reference.displayName,
    value: reference.kind === 'file'
      ? `${reference.mediaType} · ${reference.byteLength} bytes · ${reference.logicalPath}`
      : `directory · ${reference.logicalPath}`,
  }));
  if (referenceEntries.length === 0) {
    return text;
  }
  return {
    kind: 'group',
    blockId: `message:${message.messageId}`,
    source: identity,
    region: 'timeline',
    children: [
      text,
      {
        kind: 'keyValue',
        blockId: `message:${message.messageId}:filesystem-references`,
        source: identity,
        region: 'timeline',
        entries: referenceEntries,
      },
    ],
  };
}

function planBlock(plan: PlanProjection): PresentationBlock {
  const identity = source('plan', `${plan.planId}:${plan.revision}`, plan.sequence);
  const stepBlocks: PresentationBlock[] = plan.steps.map((step, index) => ({
    kind: 'section',
    blockId: `plan:${plan.planId}:${plan.revision}:step:${step.stepId}`,
    source: identity,
    region: 'timeline',
    title: `${index + 1}. ${step.title}`,
    children: [
      {
        kind: 'text',
        blockId: `plan:${plan.planId}:${plan.revision}:step:${step.stepId}:details`,
        source: identity,
        region: 'timeline',
        text: step.details,
        format: 'markdown',
      },
      ...(step.verification?.length
        ? [{
            kind: 'keyValue' as const,
            blockId: `plan:${plan.planId}:${plan.revision}:step:${step.stepId}:verification`,
            source: identity,
            region: 'timeline' as const,
            entries: step.verification.map((item, verificationIndex) => ({
              key: `verification ${verificationIndex + 1}`,
              value: item,
            })),
          }]
        : []),
    ],
  }));
  const mutationManifest = plan.mutationManifest.length
    ? [{
        kind: 'keyValue' as const,
        blockId: `plan:${plan.planId}:${plan.revision}:mutations`,
        source: identity,
        region: 'timeline' as const,
        entries: plan.mutationManifest.map((operation) => ({
          key: `${operation.workspaceId}:${operation.operation}`,
          value: operation.operation === 'bash'
            ? `${operation.executionScope}/${operation.workspaceMode}${operation.writablePaths ? ` · ${operation.writablePaths.map((target) => target.path + (target.kind === 'directory' ? '/' : '')).join(', ')}` : ''}${operation.command ? ` · ${operation.command}` : ''}`
            : operation.target,
        })),
      }]
    : [];
  return {
    kind: 'section',
    blockId: `plan:${plan.planId}:${plan.revision}`,
    source: identity,
    region: 'timeline',
    title: plan.title,
    children: [
      {
        kind: 'status',
        blockId: `plan:${plan.planId}:${plan.revision}:status`,
        source: identity,
        region: 'timeline',
        state: plan.status,
        label: plan.status,
      },
      {
        kind: 'text',
        blockId: `plan:${plan.planId}:${plan.revision}:summary`,
        source: identity,
        region: 'timeline',
        text: plan.summary,
        format: 'markdown',
      },
      ...stepBlocks,
      ...mutationManifest,
    ],
  };
}

function activityBlock(activity: ActivityProjection): PresentationBlock {
  const identity = source('activity', activity.activityId, activity.sequence);
  const children: PresentationBlock[] = [
    {
      kind: 'status',
      blockId: `activity:${activity.activityId}:status`,
      source: identity,
      region: 'timeline',
      state: activity.status,
      label: activity.label,
      ...(activity.inputRejection ? {
        error: { code: activity.inputRejection.code, message: activity.inputRejection.message },
        detail: activity.inputRejection.issues.map((issue) => (
          `${issue.path}: ${issue.message}${issue.expected === undefined ? '' : ` (${JSON.stringify(issue.expected)})`}`
        )).join('\n'),
      } : {}),
    },
  ];
  if (activity.tool) {
    children.push({
      kind: 'keyValue',
      blockId: `activity:${activity.activityId}:tool`,
      source: identity,
      region: 'timeline',
      entries: [
        { key: 'operation', value: activity.tool.operation },
        ...(activity.callId ? [{ key: 'callId', value: activity.callId }] : []),
      ],
    });
    for (const [index, resource] of activity.tool.resources.entries()) {
      if (resource.kind === 'url' && resource.uri) {
        children.push({
          kind: 'link',
          blockId: `activity:${activity.activityId}:resource:${index}`,
          source: identity,
          region: 'timeline',
          label: resource.label,
          uri: resource.uri,
        });
      } else {
        children.push({
          kind: 'keyValue',
          blockId: `activity:${activity.activityId}:resource:${index}`,
          source: identity,
          region: 'timeline',
          entries: [
            { key: 'resource', value: resource.label },
            ...(resource.workspaceId
              ? [{ key: 'workspaceId', value: resource.workspaceId }]
              : []),
            ...(resource.logicalPath
              ? [{ key: 'logicalPath', value: resource.logicalPath }]
              : []),
          ],
        });
      }
    }
    if (activity.tool.shell) {
      const shell = activity.tool.shell;
      children.push(
        {
          kind: 'code',
          blockId: `activity:${activity.activityId}:command`,
          source: identity,
          region: 'timeline',
          label: shell.cwd,
          language: 'shell',
          code: shell.command,
        },
      );
      if (shell.result) {
        children.push({
          kind: 'keyValue',
          blockId: `activity:${activity.activityId}:result`,
          source: identity,
          region: 'timeline',
          entries: [
            { key: 'exitCode', value: String(shell.result.exitCode) },
            { key: 'success', value: String(shell.result.success) },
            { key: 'timedOut', value: String(shell.result.timedOut) },
            { key: 'truncated', value: String(shell.result.truncated) },
            { key: 'capturedBytes', value: String(shell.result.capturedBytes) },
            { key: 'durationMs', value: String(shell.result.durationMs) },
          ],
        });
        if (shell.result.stdout) {
          children.push({
            kind: 'code',
            blockId: `activity:${activity.activityId}:stdout`,
            source: identity,
            region: 'timeline',
            label: 'stdout',
            code: shell.result.stdout,
          });
        }
        if (shell.result.stderr) {
          children.push({
            kind: 'code',
            blockId: `activity:${activity.activityId}:stderr`,
            source: identity,
            region: 'timeline',
            label: 'stderr',
            code: shell.result.stderr,
          });
        }
      }
    }
  }
  return {
    kind: 'group',
    blockId: `activity:${activity.activityId}`,
    source: identity,
    region: 'timeline',
    label: activity.label,
    collapsedByDefault: activity.status === 'completed',
    children,
  };
}

function timelineBlocks(projection: SessionProjection): PresentationBlock[] {
  return projection.timeline.map((item): PresentationBlock => {
    switch (item.kind) {
      case 'message':
        return messageBlock(requiredById(
          projection.messages,
          (message) => message.messageId === item.messageId,
          'presentation_timeline_message_missing',
        ));
      case 'narrative': {
        const narrative = requiredById(
          projection.narratives,
          (candidate) => candidate.narrativeId === item.narrativeId,
          'presentation_timeline_narrative_missing',
        );
        return {
          kind: 'text',
          blockId: `narrative:${narrative.narrativeId}`,
          source: source('narrative', narrative.narrativeId, item.sequence),
          region: 'timeline',
          text: narrative.content,
          format: 'markdown',
          role: 'narrative',
        };
      }
      case 'plan':
        return planBlock(requiredById(
          projection.plans,
          (plan) => plan.planId === item.planId && plan.revision === item.revision,
          'presentation_timeline_plan_missing',
        ));
      case 'toolGroup': {
        const activities = item.activityIds.map((activityId) => requiredById(
          projection.activities,
          (activity) => activity.activityId === activityId,
          'presentation_timeline_activity_missing',
        ));
        return {
          kind: 'group',
          blockId: item.timelineId,
          source: source('activity', item.timelineId, item.sequence),
          region: 'timeline',
          label: `Tools (${activities.length})`,
          collapsedByDefault: false,
          children: activities.map(activityBlock),
        };
      }
    }
  });
}

function requiredById<Value>(
  values: readonly Value[],
  predicate: (value: Value) => boolean,
  error: string,
): Value {
  const value = values.find(predicate);
  if (!value) throw new Error(error);
  return value;
}

/** Pure projection: it reads one shared Session snapshot and retains no transcript state. */
export function projectSessionPresentation(projection: SessionProjection): PresentationBlock[] {
  const blocks = timelineBlocks(projection);

  if (projection.assistantDraft) {
    const draft = projection.assistantDraft;
    for (const block of draft.blocks) {
      if (block.kind === 'providerHosted') {
        const identity = `${draft.turnId}:${block.providerCallId}`;
        blocks.push({
          kind: 'keyValue',
          blockId: `draft-hosted:${identity}`,
          source: source('assistantDraft', identity),
          region: 'transient',
          entries: [
            { key: block.providerToolType, value: block.status },
            { key: 'action', value: JSON.stringify(block.action) },
          ],
        });
      } else {
        blocks.push({
          kind: 'text',
          blockId: `draft:${block.streamId}`,
          source: source('assistantDraft', block.streamId),
          region: 'transient',
          text: block.content,
          format: 'markdown',
          role: 'draft',
        });
      }
    }
  }

  if (projection.pendingInteraction) {
    const interaction = projection.pendingInteraction;
    const identity = source('interaction', interaction.interactionId, interaction.sequence);
    blocks.push({
      kind: 'section',
      blockId: `interaction:${interaction.interactionId}`,
      source: identity,
      region: 'decision',
      title: interaction.kind,
      children: [
        {
          kind: 'text',
          blockId: `interaction:${interaction.interactionId}:prompt`,
          source: identity,
          region: 'decision',
          text: interaction.prompt,
          format: 'plain',
        },
        ...(interaction.options ?? []).map((option): PresentationBlock => ({
          kind: 'action',
          blockId: `interaction:${interaction.interactionId}:option:${option.id}`,
          source: identity,
          region: 'decision',
          actionId: option.id,
          label: option.description ? `${option.label} — ${option.description}` : option.label,
          command: {
            schemaVersion: CONVERSATION_COMMAND_VERSION,
            type: 'interaction.respond',
            sessionId: projection.sessionId,
            runId: interaction.runId,
            interactionId: interaction.interactionId,
            response: option.id,
          },
        })),
      ],
    });
  }

  if (projection.pendingApproval) {
    const approval = projection.pendingApproval;
    const identity = source('approval', approval.approvalId, approval.sequence);
    blocks.push({
      kind: 'section',
      blockId: `approval:${approval.approvalId}`,
      source: identity,
      region: 'decision',
      title: approval.preview.summary,
      children: [
        {
          kind: 'keyValue',
          blockId: `approval:${approval.approvalId}:effects`,
          source: identity,
          region: 'decision',
          entries: [
            ...approval.preview.effects.map((effect, index) => ({
              key: `effect ${index + 1}`,
              value: effect,
            })),
            ...approval.preview.logicalTargets.map((target, index) => ({
              key: `target ${index + 1}`,
              value: target,
            })),
          ],
        },
        ...(['allow', 'deny'] as const).map((decision): PresentationBlock => ({
          kind: 'action',
          blockId: `approval:${approval.approvalId}:${decision}`,
          source: identity,
          region: 'decision',
          actionId: decision,
          label: decision,
          command: {
            schemaVersion: CONVERSATION_COMMAND_VERSION,
            type: 'approval.respond',
            sessionId: projection.sessionId,
            runId: approval.runId,
            callId: approval.callId,
            approvalId: approval.approvalId,
            decision,
          },
        })),
      ],
    });
  }

  if (projection.pendingPlan) {
    const plan = projection.pendingPlan;
    const identity = source('plan', `${plan.planId}:${plan.revision}`, plan.sequence);
    blocks.push({
      kind: 'group',
      blockId: `plan:${plan.planId}:${plan.revision}:decisions`,
      source: identity,
      region: 'decision',
      children: [
        ...(['confirm', 'cancel'] as const).map((kind): PresentationBlock => ({
          kind: 'action',
          blockId: `plan:${plan.planId}:${plan.revision}:${kind}`,
          source: identity,
          region: 'decision',
          actionId: kind,
          label: kind,
          command: {
            schemaVersion: CONVERSATION_COMMAND_VERSION,
            type: 'plan.respond',
            sessionId: projection.sessionId,
            runId: plan.runId,
            planId: plan.planId,
            revision: plan.revision,
            response: { kind },
          },
        })),
      ],
    });
  }

  if (projection.todoList) {
    const todoList = projection.todoList;
    const identity = source(
      'todo',
      `${todoList.sourcePlanId}:${todoList.sourcePlanRevision}`,
      todoList.sequence,
    );
    blocks.push({
      kind: 'section',
      blockId: `todo:${todoList.sourcePlanId}:${todoList.sourcePlanRevision}`,
      source: identity,
      region: 'summary',
      title: 'Todos',
      children: todoList.items.map((item): PresentationBlock => ({
        kind: 'status',
        blockId: `todo:${item.todoId}`,
        source: identity,
        region: 'summary',
        state: item.status,
        label: item.label,
        detail: item.sourceStepId,
      })),
    });
  }

  const usage = projection.tokenUsage;
  blocks.push({
    kind: 'keyValue',
    blockId: `usage:${projection.sessionId}`,
    source: source('usage', projection.sessionId),
    region: 'summary',
    entries: [
      { key: 'providerCallCount', value: String(usage.providerCallCount) },
      { key: 'reportedCallCount', value: String(usage.reportedCallCount) },
      { key: 'inputTokens', value: String(usage.inputTokens) },
      { key: 'outputTokens', value: String(usage.outputTokens) },
      { key: 'cacheReadInputTokens', value: String(usage.cacheReadInputTokens) },
      { key: 'cacheMissInputTokens', value: String(usage.cacheMissInputTokens) },
      { key: 'cacheAvailable', value: String(usage.cacheAvailable) },
      { key: 'cacheComplete', value: String(usage.cacheComplete) },
      { key: 'cacheHitRatio', value: usage.cacheHitRatio === null ? 'unavailable' : String(usage.cacheHitRatio) },
    ],
  });

  if (projection.run) {
    const run = projection.run;
    const identity = source('run', run.runId);
    blocks.push({
      kind: 'group',
      blockId: `run:${run.runId}`,
      source: identity,
      region: 'summary',
      children: [
        {
          kind: 'status',
          blockId: `run:${run.runId}:status`,
          source: identity,
          region: 'summary',
          state: run.status,
          label: run.status,
          detail: run.waitingReason,
        },
        ...(run.status === 'running' || run.status === 'waiting'
          ? [{
              kind: 'action' as const,
              blockId: `run:${run.runId}:cancel`,
              source: identity,
              region: 'summary' as const,
              actionId: 'cancel',
              label: 'cancel',
              command: {
                schemaVersion: CONVERSATION_COMMAND_VERSION,
                type: 'run.cancel' as const,
                sessionId: projection.sessionId,
                runId: run.runId,
              },
            }]
          : []),
      ],
    });
  }

  blocks.push(...projection.artifacts.map((artifact): PresentationBlock => ({
    kind: 'artifact',
    blockId: `artifact:${artifact.artifactId}`,
    source: source('artifact', artifact.artifactId),
    region: 'summary',
    artifactId: artifact.artifactId,
    label: artifact.label,
    workspaceId: artifact.workspaceId,
    logicalPath: artifact.logicalPath,
    uri: artifact.uri,
  })));

  if (projection.terminalError) {
    blocks.push({
      kind: 'status',
      blockId: `error:${projection.sessionId}:${projection.revision}`,
      source: source('error', `${projection.sessionId}:${projection.revision}`),
      region: 'diagnostic',
      state: 'failed',
      label: projection.terminalError.message,
      error: projection.terminalError,
    });
  }

  return blocks;
}
