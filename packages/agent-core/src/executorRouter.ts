import type { ToolCall, ToolExecutionRequest, ToolResult } from '@deepcode/protocol';

export type ToolExecutor = (request: ToolExecutionRequest) => Promise<ToolResult>;

export class ToolExecutorRouter {
  private readonly executors = new Map<string, ToolExecutor>();

  register(toolName: string, executor: ToolExecutor): void {
    this.executors.set(toolName, executor);
  }

  has(toolName: string): boolean {
    return this.executors.has(toolName);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResult> {
    const executor = this.executors.get(request.toolCall.name);
    if (!executor) {
      return {
        callId: request.toolCall.id,
        ok: false,
        error: `Unsupported tool: ${request.toolCall.name}`,
      };
    }
    return executor(request);
  }
}

export function toToolCall(action: {
  id: string;
  type: string;
  payload: unknown;
}): ToolCall | null {
  if (
    action.type === 'fs.read' ||
    action.type === 'fs.list' ||
    action.type === 'code.search' ||
    action.type === 'fs.diff' ||
    action.type === 'fs.write' ||
    action.type === 'shell.propose' ||
    action.type === 'shell.exec'
  ) {
    return {
      id: action.id,
      name: action.type,
      arguments: action.payload,
    };
  }
  return null;
}
