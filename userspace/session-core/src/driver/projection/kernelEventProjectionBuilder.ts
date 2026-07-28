import {
  decodeKernelEventV1,
  type AgentConversationActivity,
  type AgentEvent,
  type ProjectionDelta,
} from '@deepcode/protocol';
import {
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from './conversationPresentationLanguage.js';

export interface KernelEventProjectionBuilderPorts {
  requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): unknown[];
  permissionBundlesFromReport(report: Record<string, unknown> | undefined): unknown[];
  gateInterventionsFromReport(report: Record<string, unknown> | undefined): unknown[];
  planReviewFacts(report: Record<string, unknown> | undefined): string[];
}

interface KernelWorkUnitFact {
  workUnit: Record<string, unknown>;
}

export class KernelEventProjectionBuilder {
  constructor(private readonly ports: KernelEventProjectionBuilderPorts) {}

  projectKernelEvent(input: {
    sessionId: string;
    event: unknown;
    ts: string;
    id: string;
    language?: ConversationPresentationLanguage;
  }): AgentEvent {
    const { sessionId, event, ts, id } = input;
    const language = input.language ?? 'neutral';
    let decoded;
    try {
      decoded = decodeKernelEventV1(event);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      return {
        id,
        sessionId,
        ts,
        kind: 'error',
        payload: {
          code: 'kernel_abi_event_invalid',
          message: localizedProjectionText(language, {
            zh: 'Kernel ABI 事件无效，Session 已停止投影该事件（错误代码：kernel_abi_event_invalid）。',
            en: `Invalid Kernel ABI event: ${rawMessage}`,
            neutral: 'kernel_abi_event_invalid',
          }),
          channel: 'error',
          visibility: 'conversation',
        },
      };
    }
    const record = decoded as unknown as Record<string, unknown>;
    const kind = decoded.kind;
    if (kind === 'proposal.reviewed') {
      const report = objectRecord(record.report) ?? {};
      const status = typeof report.status === 'string' ? report.status : 'awaitingUserApproval';
      const contract = objectRecord(report.executionContract) ?? {};
      const interventions = Array.isArray(contract.interventions) ? contract.interventions : [];
      const firstIntervention = objectRecord(interventions[0]);
      const diagnostics = Array.isArray(report.diagnostics)
        ? report.diagnostics.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      const planId = stringValue(report.proposalId) ?? stringValue(contract.proposalId) ?? 'agent-plan';
      const summary = stringValue(firstIntervention?.summary)
        ?? diagnostics[0]
        ?? localizedProjectionText(language, {
          zh: `Kernel 执行合同状态：${status}。`,
          en: `Kernel execution contract status=${status}.`,
          neutral: `Kernel contract status=${status}`,
        });
      return {
        id,
        sessionId,
        ts,
        kind: 'plan_review',
        payload: {
          title: localizedProjectionText(language, {
            zh: '计划确认',
            en: 'Plan review',
            neutral: 'Plan',
          }),
          summary,
          status,
          runId: typeof record.runId === 'string' ? record.runId : undefined,
          planId,
          confirmable: false,
          auditOnly: true,
          requiredPermissions: Array.isArray(report.requiredPermissions) ? report.requiredPermissions : [],
          requiredFileOperations: this.ports.requiredFileOperationsFromReport(report),
          permissionBundles: this.ports.permissionBundlesFromReport(report),
          interventions: this.ports.gateInterventionsFromReport(report),
          executionContract: contract,
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
      const permissionId = stringValue(request.id) ?? id;
      const capability = stringValue(request.capability);
      const riskLevel = stringValue(request.riskLevel);
      if (!capability || !riskLevel) {
        return {
          id,
          sessionId,
          ts,
          kind: 'error',
          payload: {
            code: 'kernel_permission_projection_invalid',
            message: localizedProjectionText(language, {
              zh: 'Kernel permission.requested 事件缺少类型化 capability 或 risk level。',
              en: 'Kernel permission.requested event is missing its typed capability or risk level.',
              neutral: 'kernel_permission_projection_invalid',
            }),
            channel: 'error',
            visibility: 'conversation',
            kernelEvent: record,
          },
        };
      }
      const toolName = stringValue(request.toolId)
        ?? capability;
      return {
        id,
        sessionId,
        ts,
        kind: 'permission_request',
        payload: {
          id: permissionId,
          toolName,
          capability,
          riskLevel,
          requestKind: request.requestKind,
          summary: stringValue(request.summary) ?? localizedProjectionText(language, {
            zh: `请求授权使用 ${toolName}。`,
            en: `Permission requested for ${toolName}.`,
            neutral: `Permission ${toolName}`,
          }),
          argumentsPreview: request.argsPreview ?? null,
          runId: stringValue(record.runId),
          workUnitIds: stringArrayValue(request.workUnitIds),
          affectedOperationIds: stringArrayValue(request.affectedOperationIds),
          contractId: stringValue(request.contractId),
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
      const activity = this.kernelEventActivity(record, id, undefined, language);
      return {
        id,
        sessionId,
        ts,
        kind: 'error',
        payload: {
          message: this.kernelFailureMessage(kind, record, language),
          channel: 'error',
          visibility: 'conversation',
          activity,
          kernelEvent: record,
        },
      };
    }
    const activity = this.kernelEventActivity(record, id, undefined, language);
    return {
      id,
      sessionId,
      ts,
      kind: 'workflow_stage',
      payload: {
        stage: kind,
        status: kind.endsWith('produced') || kind.endsWith('accepted') ? 'completed' : 'running',
        summary: this.kernelEventSummary(kind, record, language),
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
      const decoded = decodeKernelEventV1(event);
      if (decoded.kind !== 'work_unit.queued') continue;
      facts.set(decoded.workUnit.id, {
        workUnit: decoded.workUnit as unknown as Record<string, unknown>,
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
    const workUnitId = stringValue(record.workUnitId);
    const fact = workUnitId ? facts.get(workUnitId) : undefined;
    if (!fact) return record;
    return {
      ...record,
      projectionWorkUnit: fact.workUnit,
    };
  }

  kernelEventActivity(
    record: Record<string, unknown>,
    activityId: string,
    fallbackRunId?: string,
    language: ConversationPresentationLanguage = 'neutral'
  ): AgentConversationActivity | undefined {
    const kind = stringValue(record.kind);
    if (!kind) return undefined;
    const runId = stringValue(record.runId) ?? fallbackRunId;
    const workUnit = workUnitRecord(record);
    const fact = toolFactRecord(record);
    const targets = this.kernelEventTargets(record);
    const workUnitIds = uniqueStrings([
      stringValue(record.workUnitId),
      stringValue(workUnit?.id),
    ]);
    const actionIds = uniqueStrings([stringValue(workUnit?.actionId)]);
    const toolName = stringValue(fact?.toolId);
    const operation = this.kernelEventOperation(record, toolName);
    if (kind === 'work_unit.queued' || kind === 'action_batch.accepted') {
      return conversationActivity({
        activityId,
        kind: 'editBatchQueued',
        status: 'queued',
        title: localizedProjectionText(language, {
          zh: '编辑任务已排队',
          en: 'Edit work queued',
          neutral: 'Edit …',
        }),
        summary: this.kernelEventSummary(kind, record, language),
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
        title: localizedProjectionText(language, {
          zh: '正在编辑目标',
          en: 'Editing target',
          neutral: 'Edit …',
        }),
        summary: this.kernelEventSummary(kind, record, language),
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        operation,
        itemCount: targets.length || undefined,
      });
    }
    if (kind === 'work_unit.completed') {
      return conversationActivity({
        activityId,
        kind: 'editFileCompleted',
        status: 'completed',
        title: localizedProjectionText(language, {
          zh: '编辑已完成',
          en: 'Edit completed',
          neutral: 'Edit ✓',
        }),
        summary: this.kernelEventSummary(kind, record, language),
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
      const message = stringValue(record.message)
        ?? stringValue(error?.message)
        ?? stringValue(record.reason)
        ?? this.kernelFailureMessage(kind, record, language);
      return conversationActivity({
        activityId,
        kind: 'editFileFailed',
        status: kind === 'work_unit.blocked' ? 'blocked' : 'failed',
        title: kind === 'work_unit.blocked'
          ? localizedProjectionText(language, {
            zh: '编辑已阻塞',
            en: 'Edit blocked',
            neutral: 'Edit !',
          })
          : localizedProjectionText(language, {
            zh: '编辑失败',
            en: 'Edit failed',
            neutral: 'Edit ×',
          }),
        summary: message,
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        operation,
        errorCode: stringValue(error?.code),
        errorMessage: message,
      });
    }
    if (kind === 'tool.completed') {
      const failed = fact?.ok === false;
      const error = objectRecord(fact?.error);
      const message = stringValue(error?.message) ?? kind;
      return conversationActivity({
        activityId,
        kind: 'toolExecution',
        status: failed ? 'failed' : 'completed',
        title: failed
          ? localizedProjectionText(language, {
            zh: '工具执行失败',
            en: 'Tool failed',
            neutral: 'Tool ×',
          })
          : localizedProjectionText(language, {
            zh: '工具执行完成',
            en: 'Tool completed',
            neutral: 'Tool ✓',
          }),
        summary: message,
        source: 'kernel',
        runId,
        targets,
        actionIds,
        workUnitIds,
        toolName,
        operation,
        errorCode: failed ? stringValue(error?.code) : undefined,
        errorMessage: failed ? message : undefined,
      });
    }
    if (kind === 'resource.packet_produced') {
      return conversationActivity({
        activityId,
        kind: 'resourceRead',
        status: 'completed',
        title: localizedProjectionText(language, {
          zh: '资源上下文已解析',
          en: 'Resource context resolved',
          neutral: 'Resource ✓',
        }),
        summary: this.kernelEventSummary(kind, record, language),
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
    const output = kernelEventOutputRecord(record);
    const outputKernelContext = objectRecord(output?.kernelContext);
    const workUnit = workUnitRecord(record);
    const compiledTool = objectRecord(workUnit?.compiledTool);
    return normalizeOperation(
      stringValue(toolFactRecord(record)?.operationKind) ??
      stringValue(output?.operation) ??
      stringValue(outputKernelContext?.operationKind) ??
      stringValue(workUnit?.operationKind) ??
      stringValue(compiledTool?.operationKind) ??
      stringValue(compiledTool?.toolId) ??
      toolName
    );
  }

  kernelEventTargets(record: Record<string, unknown>): string[] {
    const output = kernelEventOutputRecord(record);
    const workUnit = workUnitRecord(record);
    const targetRef = objectRecord(workUnit?.targetRef);
    const compiledTool = objectRecord(workUnit?.compiledTool);
    const packet = record.kind === 'resource.packet_produced'
      ? objectRecord(record.packet)
      : undefined;
    const packetItems = Array.isArray(packet?.items)
      ? packet.items.map((item) => objectRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const workspaceRoots = uniqueStrings([
      stringValue(output?.workspaceRoot),
    ]);
    return uniqueTargetPaths([
      stringValue(targetRef?.path),
      stringValue(compiledTool?.path),
      stringValue(output?.path),
      stringValue(output?.targetPath),
      stringValue(output?.normalizedTargetPath),
      stringValue(output?.absolutePath),
      ...stringArrayValue(workUnit?.writeSet),
      ...packetItems.flatMap((item) => [
        stringValue(item.path),
        stringValue(item.absolutePath),
      ]),
    ], workspaceRoots);
  }

  kernelActivityDeltaType(record: Record<string, unknown>): ProjectionDelta['type'] {
    const kind = stringValue(record.kind) ?? '';
    if (kind.startsWith('work_unit.')) return 'workunit_delta';
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
    language?: ConversationPresentationLanguage;
  }): AgentConversationActivity | undefined {
    const { runId, delta } = input;
    const language = input.language ?? 'neutral';
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
        title: delta.summary ?? localizedProjectionText(language, {
          zh: '资源操作',
          en: 'Resource activity',
          neutral: 'Resource',
        }),
      });
    }
    if (delta.type === 'workunit_delta') {
      return conversationActivity({
        ...base,
        kind: status === 'failed' ? 'editFileFailed' : status === 'completed' ? 'editFileCompleted' : 'editFileStarted',
        title: delta.summary ?? localizedProjectionText(language, {
          zh: '工作区编辑',
          en: 'Workspace edit activity',
          neutral: 'Edit',
        }),
      });
    }
    if (delta.type === 'draft_delta' || delta.type === 'part_delta') {
      return conversationActivity({
        ...base,
        kind: 'toolExecution',
        title: delta.summary ?? localizedProjectionText(language, {
          zh: '草稿操作',
          en: 'Draft activity',
          neutral: 'Draft',
        }),
      });
    }
    return undefined;
  }

  private kernelFailureMessage(
    kind: string,
    record: Record<string, unknown>,
    language: ConversationPresentationLanguage
  ): string {
    const error = objectRecord(record.error);
    const reason = stringValue(record.reason)
      ?? stringValue(error?.message);
    if (kind === 'work_unit.failed') {
      const workUnitId = stringValue(record.workUnitId)
        ?? stringValue(workUnitRecord(record)?.id);
      return localizedProjectionText(language, {
        zh: workUnitId
          ? `Kernel 工作单元 ${workUnitId} 执行失败${reason ? `：${reason}` : '。'}`
          : `Kernel 工作单元执行失败${reason ? `：${reason}` : '。'}`,
        en: workUnitId
          ? `Kernel work unit ${workUnitId} failed${reason ? `: ${reason}` : '.'}`
          : `Kernel work unit failed${reason ? `: ${reason}` : '.'}`,
        neutral: `work_unit.failed${workUnitId ? ` id=${workUnitId}` : ''}${reason ? ` reason=${reason}` : ''}`,
      });
    }
    if (kind === 'proposal.rejected') {
      return localizedProjectionText(language, {
        zh: reason ? `Kernel 拒绝 proposal：${reason}` : 'Kernel 拒绝 proposal。',
        en: reason ? `Kernel rejected the proposal: ${reason}` : 'Kernel rejected the proposal.',
        neutral: `proposal.rejected${reason ? ` reason=${reason}` : ''}`,
      });
    }
    return reason ?? localizedProjectionText(language, {
      zh: 'Kernel 返回失败事件。',
      en: 'Kernel returned a failure event.',
      neutral: 'kernel.failure',
    });
  }

  private kernelEventSummary(
    kind: string,
    record: Record<string, unknown>,
    language: ConversationPresentationLanguage
  ): string {
    if (kind === 'driver.request_produced') {
      return localizedProjectionText(language, {
        zh: 'Kernel 已生成 Session DriverRequest。',
        en: 'Session DriverRequest produced by Kernel.',
        neutral: 'DriverRequest ✓',
      });
    }
    if (kind === 'state.entered') {
      return localizedProjectionText(language, {
        zh: '已进入 Kernel 状态合同。',
        en: 'Kernel state contract entered.',
        neutral: 'Kernel state ✓',
      });
    }
    if (kind === 'resource.packet_produced') {
      return localizedProjectionText(language, {
        zh: 'Kernel 已生成 ResourcePacket。',
        en: 'Kernel ResourcePacket produced.',
        neutral: 'ResourcePacket ✓',
      });
    }
    if (kind === 'proposal.accepted') {
      return localizedProjectionText(language, {
        zh: 'Kernel 已接受 proposal envelope。',
        en: 'Kernel accepted the proposal envelope.',
        neutral: 'Proposal ✓',
      });
    }
    if (kind === 'work_unit.queued') {
      return localizedProjectionText(language, {
        zh: 'Kernel 已将编辑工作单元加入队列。',
        en: 'Kernel queued the edit work unit.',
        neutral: 'work_unit.queued',
      });
    }
    if (kind === 'work_unit.started') {
      return localizedProjectionText(language, {
        zh: 'Kernel 已开始执行编辑工作单元。',
        en: 'Kernel started the edit work unit.',
        neutral: 'work_unit.started',
      });
    }
    if (kind === 'work_unit.completed') {
      return localizedProjectionText(language, {
        zh: 'Kernel 已完成编辑工作单元。',
        en: 'Kernel completed the edit work unit.',
        neutral: 'work_unit.completed',
      });
    }
    if (kind === 'tool.completed') {
      return stringValue(objectRecord(toolFactRecord(record)?.error)?.message)
        ?? localizedProjectionText(language, {
          zh: 'Kernel 工具执行完成。',
          en: 'Kernel tool execution completed.',
          neutral: kind,
        });
    }
    return kind;
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
    'fs.edit': 'patch',
    'fs.delete': 'delete',
    'fs.read': 'read',
    'fs.list': 'list',
    'fs.diff': 'diff',
    'code.grep': 'search',
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

function toolFactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record.kind === 'tool.completed' || record.kind === 'tool.requested'
    ? objectRecord(record.fact)
    : undefined;
}

function workUnitRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return objectRecord(record.workUnit) ?? objectRecord(record.projectionWorkUnit);
}

function kernelEventOutputRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.kind === 'tool.completed') {
    return objectRecord(toolFactRecord(record)?.output);
  }
  if (record.kind === 'work_unit.completed') {
    return objectRecord(record.output);
  }
  return undefined;
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
