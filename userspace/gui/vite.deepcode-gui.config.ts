import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
        manualChunks(id) {
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
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:31246',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:31246',
        ws: true,
      },
    },
  },
});
