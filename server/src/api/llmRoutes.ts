import type { FastifyInstance } from 'fastify';
import type {
  ApiResponse,
  LlmChatRequest,
  LlmChatResult,
  LlmProbeRequest,
  LlmProbeResult,
  LlmProfilesResult,
  PatchLlmProfilesRequest,
} from '@deepcode/protocol';
import {
  getLlmProfiles,
  patchLlmProfiles,
} from '../services/llmProfileService.js';
import { chatWithLlm, probeLlmProfile } from '../services/llmService.js';

function errorResponse(error: string, err: unknown): ApiResponse<never> {
  return {
    ok: false,
    error,
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function registerLlmRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/llm/profiles', async () => {
    try {
      const data = await getLlmProfiles();
      return { ok: true, data } satisfies ApiResponse<LlmProfilesResult>;
    } catch (err) {
      return errorResponse('llm_profiles_load_error', err);
    }
  });

  app.patch('/api/llm/profiles', async (request) => {
    try {
      const data = await patchLlmProfiles(request.body as PatchLlmProfilesRequest);
      return { ok: true, data } satisfies ApiResponse<LlmProfilesResult>;
    } catch (err) {
      return errorResponse('llm_profiles_patch_error', err);
    }
  });

  app.post('/api/llm/probe', async (request) => {
    const body = request.body as LlmProbeRequest | undefined;
    if (!body?.profileId) {
      return {
        ok: false,
        error: 'missing_param',
        message: '缺少 profileId',
      } satisfies ApiResponse<never>;
    }
    const data = await probeLlmProfile(body.profileId);
    return { ok: true, data } satisfies ApiResponse<LlmProbeResult>;
  });

  app.post('/api/llm/chat', async (request) => {
    try {
      const data = await chatWithLlm(request.body as LlmChatRequest);
      return { ok: true, data } satisfies ApiResponse<LlmChatResult>;
    } catch (err) {
      return errorResponse('llm_chat_error', err);
    }
  });
}
