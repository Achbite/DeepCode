import type { FastifyInstance } from 'fastify';
import type {
  AgentMode,
  ApiResponse,
  ListToolsResult,
  PermissionDecision,
  PermissionEvaluationRequest,
  ToolExecutionRequest,
  ToolResult,
} from '@deepcode/protocol';
import {
  evaluateAgentPermission,
  executeAgentTool,
  listAgentTools,
} from '../services/agentToolService.js';

function errorResponse(error: string, err: unknown): ApiResponse<never> {
  return {
    ok: false,
    error,
    message: err instanceof Error ? err.message : String(err),
  };
}

function normalizeMode(value: unknown): AgentMode | undefined {
  return value === 'readOnly' || value === 'plan' || value === 'askBeforeWrite'
    ? value
    : undefined;
}

export async function registerAgentToolRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/tools', async (request) => {
    try {
      const query = request.query as { mode?: string };
      const data = listAgentTools(normalizeMode(query.mode));
      return { ok: true, data } satisfies ApiResponse<ListToolsResult>;
    } catch (err) {
      return errorResponse('agent_tools_list_error', err);
    }
  });

  app.post('/api/agent/permissions/evaluate', async (request) => {
    try {
      const data = await evaluateAgentPermission(
        request.body as PermissionEvaluationRequest
      );
      return { ok: true, data } satisfies ApiResponse<PermissionDecision>;
    } catch (err) {
      return errorResponse('agent_permission_evaluate_error', err);
    }
  });

  app.post('/api/agent/tools/execute', async (request) => {
    try {
      const data = await executeAgentTool(request.body as ToolExecutionRequest);
      return { ok: true, data } satisfies ApiResponse<ToolResult>;
    } catch (err) {
      return errorResponse('agent_tool_execute_error', err);
    }
  });
}
