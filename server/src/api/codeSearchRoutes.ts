import type { FastifyInstance } from 'fastify';
import type { ApiResponse, CodeSearchInput, CodeSearchResult } from '@deepcode/protocol';
import { searchCode } from '../services/codeSearchService.js';

export async function registerCodeSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/code/search', async (request) => {
    try {
      const data = await searchCode(request.body as CodeSearchInput);
      return { ok: true, data } satisfies ApiResponse<CodeSearchResult>;
    } catch (err) {
      return {
        ok: false,
        error: 'code_search_error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies ApiResponse<never>;
    }
  });
}
