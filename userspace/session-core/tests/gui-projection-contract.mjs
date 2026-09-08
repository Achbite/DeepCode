import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as protocol from '@deepcode/protocol';

// Exercise the GUI's real decoder without starting a browser or Host transport.
function loadGuiSource(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports = {};
  const require = (name) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`unexpected_gui_dependency:${name}`);
    return dependencies[name];
  };
  new Function('require', 'exports', outputText)(require, exports);
  return exports;
}

const guiApi = loadGuiSource('../../gui/src/services/localAgentApi.ts', {
  '@deepcode/protocol': protocol,
  './hostTarget': {
    getKernelApiBase: () => 'http://deepcode.test',
    getHostConnectionHeaders: () => ({}),
  },
  './shellActivityCodec': loadGuiSource('../../gui/src/services/shellActivityCodec.ts'),
});

export const { inputCacheMetric, lastCallInputCacheMetric } = loadGuiSource(
  '../../gui/src/utils/providerUsage.ts',
);

export function loadGuiModelStore(api, apiClient = {}) {
  const guiRequire = createRequire(new URL('../../gui/package.json', import.meta.url));
  return loadGuiSource('../../gui/src/state/localAgentStore.ts', {
    '@deepcode/protocol': protocol,
    zustand: { create: guiRequire('zustand/vanilla').createStore },
    '../services/apiClient': apiClient,
    '../services/localAgentApi': api,
  }).useLocalAgentStore;
}

export async function decodeGuiProjection(projection) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, data: projection });
  try {
    return await guiApi.getLocalAgentProjection(projection.sessionId);
  } finally {
    globalThis.fetch = previousFetch;
  }
}
