import type { FastifyInstance } from 'fastify';
import type {
  ApiResponse,
  CreateTerminalSessionRequest,
  TerminalCapability,
  TerminalEventsResult,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionsResult,
  TerminalWarmupStatus,
} from '@deepcode/protocol';
import {
  createTerminalSession,
  deleteTerminalSession,
  getTerminalCapability,
  getTerminalEvents,
  getTerminalWarmupStatus,
  listTerminalSessions,
  resizeTerminalSession,
  restartTerminalSession,
  updateTerminalSession,
  warmupTerminalRuntime,
  writeTerminalInput,
} from '../services/terminalService.js';

function errorResponse(error: string, err: unknown): ApiResponse<never> {
  return {
    ok: false,
    error,
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function registerTerminalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/terminal/capabilities', async () => {
    return {
      ok: true,
      data: getTerminalCapability(),
    } satisfies ApiResponse<TerminalCapability>;
  });

  app.get('/api/terminal/warmup', async () => {
    return {
      ok: true,
      data: getTerminalWarmupStatus(),
    } satisfies ApiResponse<TerminalWarmupStatus>;
  });

  app.post('/api/terminal/warmup', async () => {
    return {
      ok: true,
      data: warmupTerminalRuntime(),
    } satisfies ApiResponse<TerminalWarmupStatus>;
  });

  app.get('/api/terminal/sessions', async () => {
    return {
      ok: true,
      data: listTerminalSessions(),
    } satisfies ApiResponse<TerminalSessionsResult>;
  });

  app.post('/api/terminal/sessions', async (request) => {
    try {
      const data = createTerminalSession(request.body as CreateTerminalSessionRequest | undefined);
      return { ok: true, data } satisfies ApiResponse<TerminalSession>;
    } catch (err) {
      return errorResponse('terminal_session_create_error', err);
    }
  });

  app.post('/api/terminal/sessions/:id/input', async (request) => {
    try {
      const params = request.params as { id: string };
      const data = writeTerminalInput(params.id, request.body as TerminalInputRequest);
      return { ok: true, data } satisfies ApiResponse<TerminalSession>;
    } catch (err) {
      return errorResponse('terminal_input_error', err);
    }
  });

  app.post('/api/terminal/sessions/:id/resize', async (request) => {
    try {
      const params = request.params as { id: string };
      const data = resizeTerminalSession(params.id, request.body as TerminalResizeRequest);
      return { ok: true, data } satisfies ApiResponse<TerminalSession>;
    } catch (err) {
      return errorResponse('terminal_resize_error', err);
    }
  });

  app.patch('/api/terminal/sessions/:id', async (request) => {
    try {
      const params = request.params as { id: string };
      const data = updateTerminalSession(
        params.id,
        request.body as Partial<Pick<TerminalSession, 'name' | 'order'>>
      );
      return { ok: true, data } satisfies ApiResponse<TerminalSession>;
    } catch (err) {
      return errorResponse('terminal_update_error', err);
    }
  });

  app.post('/api/terminal/sessions/:id/restart', async (request) => {
    try {
      const params = request.params as { id: string };
      const data = restartTerminalSession(params.id);
      return { ok: true, data } satisfies ApiResponse<TerminalSession>;
    } catch (err) {
      return errorResponse('terminal_restart_error', err);
    }
  });

  app.delete('/api/terminal/sessions/:id', async (request) => {
    try {
      const params = request.params as { id: string };
      const data = deleteTerminalSession(params.id);
      return { ok: true, data } satisfies ApiResponse<TerminalSession>;
    } catch (err) {
      return errorResponse('terminal_delete_error', err);
    }
  });

  app.get('/api/terminal/events', async (request) => {
    const query = request.query as { sessionId?: string; after?: string };
    const after = query.after ? Number(query.after) : undefined;
    return {
      ok: true,
      data: getTerminalEvents(query.sessionId, after),
    } satisfies ApiResponse<TerminalEventsResult>;
  });
}
