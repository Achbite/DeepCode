import type {
  PermissionDecision,
  PermissionEvaluationRequest,
  ToolCall,
} from '@deepcode/protocol';
import { ToolRegistry } from './toolRegistry.js';

export interface PermissionGateOptions {
  diffProvider?: (toolCall: ToolCall) => Promise<string | undefined>;
}

export class PermissionGate {
  constructor(
    private readonly registry = new ToolRegistry(),
    private readonly options: PermissionGateOptions = {}
  ) {}

  async evaluate(request: PermissionEvaluationRequest): Promise<PermissionDecision> {
    const tool = this.registry.find(request.toolCall.name);
    if (!tool) {
      return {
        action: 'deny',
        reason: `Unknown tool: ${request.toolCall.name}`,
      };
    }

    if (!tool.allowedModes.includes(request.mode)) {
      return {
        action: 'deny',
        reason: `${tool.name} is not allowed in ${request.mode} mode.`,
      };
    }

    if (!tool.needsApproval) {
      return {
        action: 'allow',
        reason: `${tool.name} is allowed in ${request.mode} mode.`,
      };
    }

    const diff = await this.options.diffProvider?.(request.toolCall);
    const summary =
      tool.name === 'shell.exec'
        ? 'Allow Agent to run this command in an isolated temporary shell?'
        : `Allow ${tool.name} to modify workspace files?`;
    return {
      action: 'ask',
      reason: `${tool.name} requires explicit approval before execution.`,
      request: {
        id: `perm-${request.toolCall.id}`,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
        summary,
        diff,
        argumentsPreview: request.toolCall.arguments,
      },
    };
  }
}
