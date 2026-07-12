import type {
  AgentConversationActivity,
  AgentEvent,
  ProjectionDelta,
} from '@deepcode/protocol';

export interface KernelEventProjectionBuilderPorts {
  requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): unknown[];
  requiredAccessScopesFromReport(report: Record<string, unknown> | undefined): unknown[];
  permissionBundlesFromReport(report: Record<string, unknown> | undefined): unknown[];
  gateInterventionsFromReport(report: Record<string, unknown> | undefined): unknown[];
  planReviewFacts(report: Record<string, unknown> | undefined): string[];
}

interface KernelWorkUnitFact {
  actionId?: string;
  operation?: string;
  writeSet: string[];
  deleteSet: string[];
}

export class KernelEventProjectionBuilder {
  constructor(private readonly ports: KernelEventProjectionBuilderPorts) {}

  projectKernelEvent(input: {
    sessionId: string;
    event: unknown;
    ts: string;
    id: string;
  }): AgentEvent {
    const { sessionId, event, ts, id } = input;
    const record = objectRecord(event) ?? {};
    const kind = typeof record.kind === 'string' ? record.kind : 'kernel.event';
    if (kind === 'proposal.reviewed') {
      const report = objectRecord(record.report) ?? {};
      const status = typeof report.status === 'string' ? report.status : 'awaitingUserApproval';
      const planId = typeof report.planId === 'string' ? report.planId : 'agent-plan';
      const summary = typeof report.kernelGeneratedPermissionSummary === 'string' && report.kernelGeneratedPermissionSummary.trim()
        ? report.kernelGeneratedPermissionSummary
        : 'Kernel PlanReview 已完成，请确认是否同意计划。';
      return {
        id,
        sessionId,
        ts,
        kind: 'plan_review',
        payload: {
          title: '计划确认',
          summary,
          status,
          runId: typeof record.runId === 'string' ? record.runId : undefined,
          planId,
          confirmable: false,
          auditOnly: true,
          requiredPermissions: Array.isArray(report.requiredPermissions) ? report.requiredPermissions : [],
          permissionGaps: Array.isArray(report.permissionGaps) ? report.permissionGaps : [],
          requiredFileOperations: this.ports.requiredFileOperationsFromReport(report),
          requiredAccessScopes: this.ports.requiredAccessScopesFromReport(report),
          permissionBundles: this.ports.permissionBundlesFromReport(report),
          interventions: this.ports.gateInterventionsFromReport(report),
          executionContract: objectRecord(report.executionContract) ?? undefined,
          facts: this.ports.planReviewFacts(report),
          channel: 'trace',
          visibility: 'debug',
          presentation: 'collapsible',
          report,
          kernelEvent: record,
        },
      };
    }
    if (kind === 'permission.requested') {
      const request = objectRecord(record.request) ?? {};
      const permissionId = stringValue(request.id) ?? stringValue(record.permissionId) ?? stringValue(record.toolCallId) ?? id;
      const capability = stringValue(request.capability) ?? stringValue(record.capability) ?? 'fs.write';
      const toolName = stringValue(record.toolName) ?? stringValue(request.toolName) ?? capability;
      return {
        id,
        sessionId,
        ts,
        kind: 'permission_request',
        payload: {
          id: permissionId,
          toolName,
          capability,
          riskLevel: stringValue(request.riskLevel) ?? stringValue(request.risk_level) ?? stringValue(record.riskLevel) ?? 'medium',
          summary: stringValue(request.summary) ?? stringValue(record.summary) ?? `Permission requested for ${toolName}.`,
          argumentsPreview: request.argsPreview ?? record.argsPreview ?? null,
          runId: stringValue(record.runId),
          workUnitId: stringValue(record.workUnitId),
          actionId: stringValue(record.actionId),
          planId: stringValue(record.planId),
          operationKind: stringValue(record.operationKind),
          channel: 'tool',
          visibility: 'conversation',
          kernelEvent: record,
        },
      };
    }
    if (kind === 'permission.resolved') {
      return {
        id,
        sessionId,
        ts,
        kind: 'permission_result',
        payload: {
          permissionId: stringValue(record.permissionId),
          decision: record.decision,
          runId: stringValue(record.runId),
          channel: 'tool',
          visibility: 'conversation',
          kernelEvent: record,
        },
      };
    }
    if (kind === 'proposal.rejected' || kind === 'work_unit.failed') {
      const activity = this.kernelEventActivity(record, id);
      return {
        id,
        sessionId,
        ts,
        kind: 'error',
        payload: {
          message: this.kernelFailureMessage(kind, record),
          channel: 'error',
          visibility: 'conversation',
          activity,
          kernelEvent: record,
        },
      };
    }
    const activity = this.kernelEventActivity(record, id);
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: kind,
        status: kind.endsWith('produced') || kind.endsWith('accepted') ? 'completed' : 'running',
        summary: this.kernelEventSummary(kind, record),
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'collapsible',
        activity,
        kernelEvent: record,
      },
    };
  }

  indexKernelWorkUnitFacts(events: unknown[]): Map<string, KernelWorkUnitFact> {
    const facts = new Map<string, KernelWorkUnitFact>();
    for (const event of events) {
      const record = objectRecord(event);
      if (record?.kind !== 'work_unit.queued') continue;
      const workUnit = objectRecord(record.workUnit);
      const id = stringValue(workUnit?.id) ?? stringValue(record.workUnitId);
      if (!id) continue;
      const writeSet = uniqueStrings([
        ...stringArrayValue(record.writeSet),
        ...stringArrayValue(workUnit?.writeSet),
      ]);
      const deleteSet = uniqueStrings([
        ...stringArrayValue(record.deleteSet),
        ...stringArrayValue(workUnit?.deleteSet),
      ]);
      const fallbackTargets = this.kernelEventTargets(record);
      facts.set(id, {
        actionId: stringValue(record.actionId) ?? stringValue(workUnit?.actionId),
        operation: this.kernelEventOperation(record),
        writeSet: writeSet.length ? writeSet : fallbackTargets,
        deleteSet,
      });
    }
    return facts;
  }

  enrichKernelWorkUnitRecord(
    record: Record<string, unknown>,
    facts: Map<string, KernelWorkUnitFact>
  ): Record<string, unknown> {
    const kind = stringValue(record.kind);
    if (!kind?.startsWith('work_unit.') || kind === 'work_unit.queued') return record;
    const workUnit = objectRecord(record.workUnit);
    const hasActionId = Boolean(stringValue(record.actionId) ?? stringValue(workUnit?.actionId));
    if (this.kernelEventTargets(record).length > 0 && this.kernelEventOperation(record) && hasActionId) return record;
    const workUnitId = stringValue(record.workUnitId) ?? stringValue(workUnit?.id);
    const fact = workUnitId ? facts.get(workUnitId) : undefined;
    if (!fact || (fact.writeSet.length === 0 && fact.deleteSet.length === 0 && !fact.actionId && !fact.operation)) return record;
    const enrichedWorkUnit = {
      ...(workUnit ?? {}),
      ...(workUnitId ? { id: workUnitId } : {}),
      ...(fact.actionId && !stringValue(workUnit?.actionId) ? { actionId: fact.actionId } : {}),
      ...(fact.writeSet.length && stringArrayValue(workUnit?.writeSet).length === 0 ? { writeSet: fact.writeSet } : {}),
      ...(fact.deleteSet.length && stringArrayValue(workUnit?.deleteSet).length === 0 ? { deleteSet: fact.deleteSet } : {}),
    };
    return {
      ...record,
      ...(!stringValue(record.actionId) && fact.actionId ? { actionId: fact.actionId } : {}),
      ...(!this.kernelEventOperation(record) && fact.operation ? { operation: fact.operation } : {}),
      ...(stringArrayValue(record.writeSet).length === 0 && fact.writeSet.length ? { writeSet: fact.writeSet } : {}),
      ...(stringArrayValue(record.deleteSet).length === 0 && fact.deleteSet.length ? { deleteSet: fact.deleteSet } : {}),
      workUnit: enrichedWorkUnit,
    };
  }

  kernelEventActivity(
    record: Record<string, unknown>,
    activityId: string,
    fallbackRunId?: string
  ): AgentConversationActivity | undefined {
    const kind = stringValue(record.kind);
    if (!kind) return undefined;
    const runId = stringValue(record.runId) ?? fallbackRunId;
    const workUnit = objectRecord(record.workUnit);
    const tool = objectRecord(record.tool);
    const targets = this.kernelEventTargets(record);
    const workUnitIds = uniqueStrings([
      stringValue(record.workUnitId),
      stringValue(workUnit?.id),
    ]);
    const actionIds = uniqueStrings([
      stringValue(record.actionId),
      stringValue(workUnit?.actionId),
    ]);
    const toolName = stringValue(record.toolName) ?? stringValue(tool?.name) ?? stringValue(record.name);
    const operation = this.kernelEventOperation(record, toolName);
    if (kind === 'work_unit.queued' || kind === 'action_batch.accepted') {
      return conversationActivity({
        activityId,
        kind: 'editBatchQueued',
        status: 'queued',
        title: 'Edit work queued',
        summary: this.kernelEventSummary(kind, record),
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        operation,
        itemCount: targets.length || actionIds.length || workUnitIds.length || undefined,
      });
    }
    if (kind === 'work_unit.started') {
      return conversationActivity({
        activityId,
        kind: 'editFileStarted',
        status: 'running',
        title: 'Editing target',
        summary: this.kernelEventSummary(kind, record),
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        operation,
        itemCount: targets.length || undefined,
      });
    }
    if (kind === 'work_unit.completed' || kind === 'workspace.result') {
      return conversationActivity({
        activityId,
        kind: 'editFileCompleted',
        status: 'completed',
        title: 'Edit completed',
        summary: this.kernelEventSummary(kind, record),
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        operation,
        itemCount: targets.length || undefined,
      });
    }
    if (kind === 'work_unit.failed' || kind === 'work_unit.blocked' || kind === 'proposal.rejected') {
      const error = objectRecord(record.error);
      const message = stringValue(record.message) ?? stringValue(error?.message) ?? stringValue(record.reason) ?? this.kernelFailureMessage(kind, record);
      return conversationActivity({
        activityId,
        kind: 'editFileFailed',
        status: kind === 'work_unit.blocked' ? 'blocked' : 'failed',
        title: kind === 'work_unit.blocked' ? 'Edit blocked' : 'Edit failed',
        summary: message,
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        operation,
        errorCode: stringValue(record.code) ?? stringValue(error?.code),
        errorMessage: message,
      });
    }
    if (kind === 'tool.completed' || kind === 'tool.failed') {
      const failed = kind === 'tool.failed';
      const error = objectRecord(record.error);
      const message = stringValue(record.summary) ?? stringValue(error?.message) ?? kind;
      return conversationActivity({
        activityId,
        kind: 'toolExecution',
        status: failed ? 'failed' : 'completed',
        title: failed ? 'Tool failed' : 'Tool completed',
        summary: message,
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        toolName,
        operation,
        errorCode: failed ? stringValue(record.code) ?? stringValue(error?.code) : undefined,
        errorMessage: failed ? message : undefined,
      });
    }
    if (kind === 'resource.packet_produced') {
      return conversationActivity({
        activityId,
        kind: 'resourceRead',
        status: 'completed',
        title: 'Resource context resolved',
        summary: this.kernelEventSummary(kind, record),
        source: 'kernel',
        runId,
        targets,
        operation: 'read',
        itemCount: targets.length || undefined,
      });
    }
    return undefined;
  }

  private kernelEventOperation(record: Record<string, unknown>, toolName?: string): string | undefined {
    const output = objectRecord(record.output);
    const outputKernelContext = objectRecord(output?.kernelContext);
    const workUnit = objectRecord(record.workUnit);
    const compiledTool = objectRecord(workUnit?.compiledTool) ?? objectRecord(record.compiledTool);
    return normalizeOperation(
      stringValue(record.operation) ??
      stringValue(record.operationKind) ??
      stringValue(output?.operation) ??
      stringValue(outputKernelContext?.operationKind) ??
      stringValue(workUnit?.kind) ??
      stringValue(compiledTool?.toolName) ??
      toolName
    );
  }

  kernelEventTargets(record: Record<string, unknown>): string[] {
    const output = objectRecord(record.output);
    const result = objectRecord(record.result);
    const workUnit = objectRecord(record.workUnit);
    const compiledTool = objectRecord(workUnit?.compiledTool) ?? objectRecord(record.compiledTool);
    const workspaceRoots = uniqueStrings([
      stringValue(record.workspaceRoot),
      stringValue(output?.workspaceRoot),
      stringValue(result?.workspaceRoot),
      stringValue(workUnit?.workspaceRoot),
    ]);
    return uniqueTargetPaths([
      stringValue(record.path),
      stringValue(record.targetPath),
      stringValue(record.normalizedTargetPath),
      stringValue(record.resourcePath),
      ...stringArrayValue(record.writeSet),
      ...stringArrayValue(record.deleteSet),
      stringValue(compiledTool?.path),
      stringValue(output?.path),
      stringValue(output?.targetPath),
      stringValue(output?.normalizedTargetPath),
      stringValue(output?.absolutePath),
      stringValue(result?.path),
      stringValue(result?.targetPath),
      stringValue(result?.normalizedTargetPath),
      ...stringArrayValue(workUnit?.writeSet),
      ...stringArrayValue(workUnit?.deleteSet),
    ], workspaceRoots);
  }

  kernelActivityDeltaType(record: Record<string, unknown>): ProjectionDelta['type'] {
    const kind = stringValue(record.kind) ?? '';
    if (kind.startsWith('work_unit.') || kind === 'workspace.result') return 'workunit_delta';
    if (kind.startsWith('tool.')) return 'tool_call_delta';
    if (kind.startsWith('resource.')) return 'resource_delta';
    return 'stage_delta';
  }

  kernelActivityChannel(activity: AgentConversationActivity): ProjectionDelta['channel'] {
    if (activity.kind === 'resourceRead' || activity.kind === 'resourceSearch') return 'resource';
    if (activity.kind === 'toolExecution') return 'tool';
    if (activity.kind.startsWith('edit')) return 'workunit';
    if (activity.kind === 'providerThinking') return 'reasoning';
    return 'progress';
  }

  projectionStatusForActivity(activity: AgentConversationActivity): ProjectionDelta['status'] {
    return activity.status === 'blocked' ? 'failed' : activity.status;
  }

  projectionDeltaActivity(input: {
    runId: string;
    delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>;
  }): AgentConversationActivity | undefined {
    const { runId, delta } = input;
    const status = activityStatusFromDelta(delta.status);
    if (!status) return undefined;
    const stage = delta.stage ?? delta.type;
    const base = {
      activityId: `${stage}-${delta.itemId ?? status}`,
      status,
      title: delta.summary ?? stage,
      summary: delta.summary ?? stage,
      source: activitySourceFromDelta(delta.source),
      runId,
      draftId: delta.draftId,
      targets: uniqueStrings([delta.targetPath]),
      operation: normalizeOperation(
        stringValue(objectRecord(delta.payload)?.operation) ??
        stringValue(objectRecord(delta.payload)?.operationKind) ??
        delta.activity?.operation ??
        delta.activity?.toolName
      ),
    };
    if (delta.type === 'resource_delta') {
      return conversationActivity({
        ...base,
        kind: stage.includes('search') ? 'resourceSearch' : 'resourceRead',
        title: delta.summary ?? 'Resource activity',
      });
    }
    if (delta.type === 'workunit_delta') {
      return conversationActivity({
        ...base,
        kind: status === 'failed' ? 'editFileFailed' : status === 'completed' ? 'editFileCompleted' : 'editFileStarted',
        title: delta.summary ?? 'Workspace edit activity',
      });
    }
    if (delta.type === 'draft_delta' || delta.type === 'part_delta') {
      return conversationActivity({
        ...base,
        kind: 'toolExecution',
        title: delta.summary ?? 'Draft activity',
      });
    }
    return undefined;
  }

  private kernelFailureMessage(kind: string, record: Record<string, unknown>): string {
    const error = objectRecord(record.error);
    const reason = stringValue(record.reason)
      ?? stringValue(record.summary)
      ?? stringValue(error?.message)
      ?? stringValue(error?.reason)
      ?? stringValue(record.message);
    if (kind === 'work_unit.failed') {
      const workUnitId = stringValue(record.workUnitId)
        ?? stringValue(objectRecord(record.workUnit)?.id)
        ?? stringValue(record.actionId);
      const suffix = reason ? `：${reason}` : '。';
      return workUnitId
        ? `Kernel work unit ${workUnitId} 执行失败${suffix}`
        : `Kernel work unit 执行失败${suffix}`;
    }
    if (kind === 'proposal.rejected') {
      return reason ? `Kernel 拒绝 proposal：${reason}` : 'Kernel 拒绝 proposal。';
    }
    return reason ?? 'Kernel 返回失败事件。';
  }

  private kernelEventSummary(kind: string, record: Record<string, unknown>): string {
    if (kind === 'driver.request_produced') return 'Session DriverRequest produced by Kernel.';
    if (kind === 'state.entered') return 'Kernel state contract entered.';
    if (kind === 'resource.packet_produced') return 'Kernel ResourcePacket produced.';
    if (kind === 'proposal.accepted') return 'Kernel accepted proposal envelope.';
    return typeof record.summary === 'string' ? record.summary : kind;
  }
}

function conversationActivity(input: AgentConversationActivity): AgentConversationActivity {
  return {
    ...input,
    targets: uniqueStrings(input.targets ?? []),
    actionIds: uniqueStrings(input.actionIds ?? []),
    workUnitIds: uniqueStrings(input.workUnitIds ?? []),
  };
}

function activitySourceFromDelta(source: ProjectionDelta['source'] | undefined): AgentConversationActivity['source'] {
  if (source === 'kernel' || source === 'provider' || source === 'llm') return source;
  return 'session';
}

function activityStatusFromDelta(status: ProjectionDelta['status'] | undefined): AgentConversationActivity['status'] | undefined {
  if (status === 'queued' || status === 'running' || status === 'waiting' || status === 'completed' || status === 'failed') return status;
  if (status === 'streaming') return 'running';
  if (status === 'draftReady') return 'completed';
  if (status === 'discarded' || status === 'skipped') return 'blocked';
  return undefined;
}

function normalizeOperation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  const operations: Record<string, string> = {
    'fs.write': 'write',
    'fs.patch': 'patch',
    'fs.delete': 'delete',
    'fs.read': 'read',
    'fs.list': 'list',
    'fs.diff': 'diff',
    'code.search': 'search',
    'process.exec': 'exec',
    write: 'write',
    create: 'create',
    patch: 'patch',
    delete: 'delete',
    rename: 'rename',
    read: 'read',
    list: 'list',
    diff: 'diff',
    search: 'search',
    exec: 'exec',
  };
  return operations[normalized] ?? normalized;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function uniqueTargetPaths(
  values: Array<string | undefined>,
  workspaceRoots: string[]
): string[] {
  const roots = workspaceRoots.map(normalizeComparablePath).filter(Boolean);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const displayPath = value.trim();
    if (!displayPath) continue;
    const normalizedPath = normalizeComparablePath(displayPath);
    const workspaceRelativePath = roots.reduce<string | undefined>((relative, root) => {
      if (relative) return relative;
      if (normalizedPath === root) return '.';
      if (root === '/' && normalizedPath.startsWith('/')) return normalizedPath.slice(1);
      return normalizedPath.startsWith(`${root}/`)
        ? normalizedPath.slice(root.length + 1)
        : undefined;
    }, undefined);
    const identity = workspaceRelativePath ?? normalizedPath;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    output.push(workspaceRelativePath ?? displayPath);
  }
  return output;
}

function normalizeComparablePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/^\.\//, '').replace(/\/+$/g, '');
}
