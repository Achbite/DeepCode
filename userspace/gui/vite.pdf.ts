import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Keep PDF fonts, CMaps and decoders local in both web and native packages. */
export function pdfDocumentAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const files = new Map<string, string>();
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      if (entry.isFile()) files.set(`pdfjs/${folder}/${entry.name}`, join(root, folder, entry.name));
    }
  }
  return {
    name: 'pdf-document-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const key = (request.url ?? '').split('?', 1)[0].replace(/^\//, '');
        const path = files.get(key);
        if (!path) return next();
        response.setHeader('Content-Type', key.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [fileName, path] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  };
}
