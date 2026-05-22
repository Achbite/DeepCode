import type {
  AgentActionParseRequest,
  AgentActionParseResult,
  AgentMode,
  AgentObservation,
  ParsedAgentAction,
  ParsedAgentActionError,
  ToolCall,
  ToolResult,
} from '@deepcode/protocol';
import { AgentActionParser } from './actionParser.js';
import { PermissionGate } from './permissionGate.js';
import { ToolExecutorRouter, toToolCall } from './executorRouter.js';
import { nowIso } from './utils.js';

export interface AgentWorkflowRunRequest extends AgentActionParseRequest {
  sessionId: string;
  execute?: boolean;
  approveAll?: boolean;
  approvedActionIds?: string[];
  approvedToolNames?: string[];
}

export interface AgentWorkflowRunResult {
  parse: AgentActionParseResult;
  observations: AgentObservation[];
}

export class AgentWorkflowRunner {
  constructor(
    private readonly parser: AgentActionParser,
    private readonly permissionGate: PermissionGate,
    private readonly executorRouter: ToolExecutorRouter
  ) {}

  async run(request: AgentWorkflowRunRequest): Promise<AgentWorkflowRunResult> {
    const parse = this.parser.parse(request);
    const observations: AgentObservation[] = [];
    const mode: AgentMode = request.mode ?? 'plan';

    for (const action of parse.actions) {
      observations.push(
        ...(await this.runAction(action, {
          sessionId: request.sessionId,
          mode,
          execute: request.execute !== false,
          approveAll: request.approveAll === true,
          approvedActionIds: request.approvedActionIds ?? [],
          approvedToolNames: request.approvedToolNames ?? [],
        }))
      );
    }

    return { parse, observations };
  }

  private async runAction(
    action: ParsedAgentAction,
    options: {
      sessionId: string;
      mode: AgentMode;
      execute: boolean;
      approveAll: boolean;
      approvedActionIds: string[];
      approvedToolNames: string[];
    }
  ): Promise<AgentObservation[]> {
    if (action.status !== 'parsed') {
      return [
        observation(
          options.sessionId,
          action,
          'error',
          `Invalid action: ${action.errors?.[0]?.message ?? 'unknown error'}`,
          undefined,
          action.errors?.[0]
        ),
      ];
    }

    if (action.type === 'final') {
      return [observation(options.sessionId, action, 'ok', 'Final message parsed.', action.payload)];
    }

    if (action.type === 'patch.plan') {
      return [
        observation(
          options.sessionId,
          action,
          'needsApproval',
          'Patch plan parsed and queued for diff approval.',
          action.payload
        ),
      ];
    }

    const toolCall = toToolCall(action);
    if (!toolCall) {
      return [observation(options.sessionId, action, 'blocked', 'No executor for action.')];
    }

    const permission = await this.permissionGate.evaluate({
      mode: options.mode,
      toolCall,
    });
    if (permission.action === 'deny') {
      return [
        observation(options.sessionId, action, 'blocked', permission.reason, undefined, {
          code: 'permission_denied',
          message: permission.reason,
        }),
      ];
    }

    const approved =
      options.approveAll ||
      options.approvedActionIds.includes(action.id) ||
      options.approvedToolNames.includes(toolCall.name);

    if (permission.action === 'ask' && !approved) {
      return [observation(options.sessionId, action, 'needsApproval', permission.reason, permission.request)];
    }

    if (!options.execute) {
      return [observation(options.sessionId, action, 'ok', 'Action parsed; execution skipped.')];
    }

    const result = await this.executorRouter.execute({
      mode: options.mode,
      toolCall,
      approved: permission.action !== 'ask' || approved,
    });
    return [observationFromToolResult(options.sessionId, action, toolCall, result)];
  }
}

function observation(
  sessionId: string,
  action: ParsedAgentAction,
  status: AgentObservation['status'],
  summary: string,
  output?: unknown,
  error?: ParsedAgentActionError
): AgentObservation {
  return {
    id: `obs-${action.id}`,
    sessionId,
    actionId: action.id,
    toolName: action.type,
    status,
    summary,
    output,
    error,
    createdAt: nowIso(),
  };
}

function observationFromToolResult(
  sessionId: string,
  action: ParsedAgentAction,
  toolCall: ToolCall,
  result: ToolResult
): AgentObservation {
  return result.ok
    ? observation(sessionId, action, 'ok', `${toolCall.name} completed.`, result.output)
    : observation(sessionId, action, 'error', result.error ?? `${toolCall.name} failed.`, undefined, {
        code: 'tool_error',
        message: result.error ?? `${toolCall.name} failed.`,
      });
}
