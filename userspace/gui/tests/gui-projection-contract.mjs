import assert from 'node:assert/strict';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Load the real GUI module graph without a browser, file watcher, or listening server.
function createGuiLoader() {
  return createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    envFile: false,
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
}

const guiLoader = await createGuiLoader();
after(() => guiLoader.close());
let guiApi;
let usage;
try {
  guiApi = await guiLoader.ssrLoadModule('/src/services/localAgentApi.ts');
  usage = await guiLoader.ssrLoadModule('/src/utils/providerUsage.ts');
} catch (error) {
  await guiLoader.close();
  throw error;
}

export const { inputCacheMetric, lastCallInputCacheMetric } = usage;

export async function loadGuiModelStore(t) {
  // Each store case owns its module-level initialization and request lifecycle.
  const loader = await createGuiLoader();
  t.after(() => loader.close());
  return (await loader.ssrLoadModule('/src/state/localAgentStore.ts')).useLocalAgentStore;
}

export function installGuiFetch(t, handler) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(new URL(url), init);
  t.after(() => { globalThis.fetch = previousFetch; });
}

export async function decodeGuiProjection(projection) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).pathname,
      `/api/conversation/sessions/${encodeURIComponent(projection.sessionId)}/projection`);
    assert.equal(init.method ?? 'GET', 'GET');
    return Response.json({ ok: true, data: projection });
  };
  try {
    return await guiApi.getLocalAgentProjection(projection.sessionId);
  } finally {
    globalThis.fetch = previousFetch;
  }
}
