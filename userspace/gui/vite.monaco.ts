import type { Plugin } from 'vite';

export function monacoHostWorkers(): Plugin {
  return {
    name: 'monaco-host-workers',
    enforce: 'pre',
    transform(source, id) {
      if (!/\/monaco-editor\/esm\/vs\/language\/(json|css|html|typescript)\/workerManager\.js$/.test(id)) {
        return;
      }
      // monacoRuntime supplies every Worker through MonacoEnvironment.getWorker.
      // Remove the unused default factories before Vite discovers their URLs,
      // so it does not compile and emit a second copy of each language Worker.
      return {
        code: source.replace(
          /^\s*createWorker: \(\) => new Worker\(new URL\('[^']+\.worker\.js', import\.meta\.url\), \{ type: "module" \}\),\r?\n/m,
          '',
        ),
        map: null,
      };
    },
  };
}
