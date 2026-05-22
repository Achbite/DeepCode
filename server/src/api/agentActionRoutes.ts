import type { FastifyInstance } from 'fastify';
import type {
  AgentActionParseRequest,
  AgentActionParseResult,
  AgentFixtureRunRequest,
  AgentFixtureRunResult,
  ApiResponse,
  PromptLayerResult,
  SkillReferenceResult,
} from '@deepcode/protocol';
import {
  parseAgentActions,
  runAgentFixture,
} from '../modules/agent/index.js';
import {
  listPromptLayers,
  listSkills,
} from '../services/agentContextSourceService.js';

function errorResponse(error: string, err: unknown): ApiResponse<never> {
  return {
    ok: false,
    error,
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function registerAgentActionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/agent/parse-actions', async (request) => {
    try {
      const data = parseAgentActions(request.body as AgentActionParseRequest);
      return { ok: true, data } satisfies ApiResponse<AgentActionParseResult>;
    } catch (err) {
      return errorResponse('agent_action_parse_error', err);
    }
  });

  app.post('/api/agent/fixtures/run', async (request) => {
    try {
      const data = await runAgentFixture(request.body as AgentFixtureRunRequest);
      return { ok: true, data } satisfies ApiResponse<AgentFixtureRunResult>;
    } catch (err) {
      return errorResponse('agent_fixture_run_error', err);
    }
  });

  app.get('/api/agent/prompt-layers', async () => {
    return {
      ok: true,
      data: listPromptLayers(),
    } satisfies ApiResponse<PromptLayerResult>;
  });

  app.get('/api/agent/skills', async () => {
    return {
      ok: true,
      data: await listSkills(),
    } satisfies ApiResponse<SkillReferenceResult>;
  });
}
