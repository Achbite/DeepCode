import type {
  AgentMode,
  PermissionDecision,
  PermissionRequest,
  ToolCall,
} from '@deepcode/protocol';
import { getToolDefinition } from './toolRegistry';

function makePermissionRequest(toolCall: ToolCall): PermissionRequest {
  const tool = getToolDefinition(toolCall.name);
  return {
    id: `perm-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    toolName: toolCall.name,
    riskLevel: tool?.riskLevel ?? 'medium',
    summary: toolCall.name === 'fs.write'
      ? 'Agent 请求写入工作区文件'
      : 'Agent 请求执行需要确认的操作',
    argumentsPreview: toolCall.arguments,
  };
}

export function evaluatePermission(
  toolCall: ToolCall,
  mode: AgentMode
): PermissionDecision {
  const tool = getToolDefinition(toolCall.name);
  if (!tool) {
    return {
      action: 'deny',
      reason: `未注册工具: ${toolCall.name}`,
    };
  }
  if (!tool.allowedModes.includes(mode)) {
    return {
      action: 'deny',
      reason: `${mode} 模式不允许调用 ${toolCall.name}`,
    };
  }
  if (toolCall.name === 'fs.write') {
    if (mode !== 'askBeforeWrite') {
      return {
        action: 'deny',
        reason: `${mode} 模式不允许直接写盘`,
      };
    }
    return {
      action: 'ask',
      reason: '写盘前必须由用户确认 diff',
      request: makePermissionRequest(toolCall),
    };
  }
  if (tool.needsApproval && toolCall.name !== 'shell.propose') {
    return {
      action: 'ask',
      reason: '该工具需要用户确认',
      request: makePermissionRequest(toolCall),
    };
  }
  return {
    action: 'allow',
    reason: '允许执行',
  };
}
