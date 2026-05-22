import type { FastifyInstance } from 'fastify';
import type {
  AgentSessionResult,
  ApiResponse,
  AppendAgentEventsRequest,
  CreateAgentSessionRequest,
  AgentFeedbackRequest,
  AgentFeedbackResult,
  GetAgentWorkflowConfigResult,
  PatchAgentWorkflowConfigRequest,
  ResolveAgentPermissionRequest,
  SendAgentMessageRequest,
} from '@deepcode/protocol';
import {
  appendAgentEvents,
  createAgentSession,
  getAgentSession,
} from '../services/agentSessionStore.js';
import {
  resolveAgentPermission,
  sendAgentMessage,
} from '../modules/agent/workflowService.js';
import {
  getAgentWorkflowConfig,
  patchAgentWorkflowConfig,
} from '../services/agentWorkflowConfigService.js';

function errorResponse(error: string, err: unknown): ApiResponse<never> {
  return {
    ok: false,
    error,
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent/workflow-config', async () => {
    try {
      const data = await getAgentWorkflowConfig();
      return { ok: true, data } satisfies ApiResponse<GetAgentWorkflowConfigResult>;
    } catch (err) {
      return errorResponse('agent_workflow_config_load_error', err);
    }
  });

  app.patch('/api/agent/workflow-config', async (request) => {
    try {
      const data = await patchAgentWorkflowConfig(request.body as PatchAgentWorkflowConfigRequest);
      return { ok: true, data } satisfies ApiResponse<GetAgentWorkflowConfigResult>;
    } catch (err) {
      return errorResponse('agent_workflow_config_patch_error', err);
    }
  });

  app.post('/api/agent/sessions', async (request) => {
    try {
      const body = request.body as CreateAgentSessionRequest | undefined;
      const data = await createAgentSession(body?.initialMode, body?.profileId);
      return { ok: true, data } satisfies ApiResponse<AgentSessionResult>;
    } catch (err) {
      return errorResponse('agent_session_create_error', err);
    }
  });

  app.get('/api/agent/sessions/current', async () => {
    try {
      const data = await getAgentSession();
      return { ok: true, data } satisfies ApiResponse<AgentSessionResult | null>;
    } catch (err) {
      return errorResponse('agent_session_load_error', err);
    }
  });

  app.get('/api/agent/sessions/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const data = await getAgentSession(id);
      if (!data) {
        return {
          ok: false,
          error: 'agent_session_not_found',
          message: '会话不存在',
        } satisfies ApiResponse<never>;
      }
      return { ok: true, data } satisfies ApiResponse<AgentSessionResult>;
    } catch (err) {
      return errorResponse('agent_session_load_error', err);
    }
  });

  app.post('/api/agent/sessions/:id/events', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as AppendAgentEventsRequest;
      const data = await appendAgentEvents(id, body.events ?? []);
      return { ok: true, data } satisfies ApiResponse<AgentSessionResult>;
    } catch (err) {
      return errorResponse('agent_events_append_error', err);
    }
  });

  app.post('/api/agent/sessions/:id/messages', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const data = await sendAgentMessage(id, request.body as SendAgentMessageRequest);
      return { ok: true, data } satisfies ApiResponse<AgentSessionResult>;
    } catch (err) {
      return errorResponse('agent_message_send_error', err);
    }
  });

  app.post('/api/agent/permissions/:id/resolve', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const data = await resolveAgentPermission(
        id,
        request.body as ResolveAgentPermissionRequest
      );
      return { ok: true, data } satisfies ApiResponse<AgentSessionResult>;
    } catch (err) {
      return errorResponse('agent_permission_resolve_error', err);
    }
  });

  app.post('/api/agent/feedback', async (request) => {
    const body = request.body as AgentFeedbackRequest;
    return {
      ok: true,
      data: {
        accepted: Boolean(body.eventId && body.rating),
        message: 'Agent feedback endpoint is reserved for future model-quality data collection.',
      },
    } satisfies ApiResponse<AgentFeedbackResult>;
  });
}
