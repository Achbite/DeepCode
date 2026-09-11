import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { monacoHostWorkers } from './vite.monaco';

function deepcodeGuiDevelopmentEntry(): Plugin {
  return {
    name: 'deepcode-gui-development-entry',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const [pathname, query] = (request.url ?? '/').split('?', 2);
        if (pathname === '/' || pathname === '/index.html') {
          request.url = `/deepcode-gui.html${query ? `?${query}` : ''}`;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const host = process.env.DEEPCODE_HOST ?? '127.0.0.1';
  const hostPort = process.env.DEEPCODE_HOST_PORT ?? '31245';
  const devPort = Number(process.env.DEEPCODE_GUI_DEV_PORT ?? '5174');
  const uiToken = process.env.DEEPCODE_HOST_UI_TOKEN ?? '';
  if (command === 'serve') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('DeepCode-GUI Web development Host must be loopback.');
    }
    if (!Number.isSafeInteger(devPort) || devPort < 1 || devPort > 65_535) {
      throw new Error('DEEPCODE_GUI_DEV_PORT must be an integer from 1 to 65535.');
    }
    if (!/^dcui_[0-9a-f]{64}$/.test(uiToken)) {
      throw new Error('DEEPCODE_HOST_UI_TOKEN is required for Web development mode.');
    }
  }
  const target = `http://${host}:${hostPort}`;
  const proxyOptions = {
    target,
    changeOrigin: true,
    configure(proxy: { on: (event: string, listener: (request: { setHeader: (name: string, value: string) => void }) => void) => void }) {
      proxy.on('proxyReq', (request) => {
        request.setHeader('origin', target);
        request.setHeader('x-deepcode-host-ui-token', uiToken);
      });
    },
  };
  return {
    plugins: [deepcodeGuiDevelopmentEntry(), react(), monacoHostWorkers()],
    base: './',
    build: {
      outDir: 'dist-deepcode-gui',
      emptyOutDir: true,
      chunkSizeWarningLimit: 650,
      rollupOptions: {
        input: {
          index: 'deepcode-gui.html',
        },
        output: {
          manualChunks(id: string) {
            if (id.includes('monaco-editor') || id.includes('@monaco-editor')) {
              return 'monaco';
            }
            if (
              id.includes('react-markdown') ||
              id.includes('remark-') ||
              id.includes('rehype-') ||
              id.includes('katex')
            ) {
              return 'markdown-renderer';
            }
            if (id.includes('react') || id.includes('react-dom') || id.includes('zustand')) {
              return 'vendor';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: devPort,
      strictPort: true,
      proxy: {
        '/api': proxyOptions,
        '/ws': { ...proxyOptions, ws: true },
      },
    },
  };
});
