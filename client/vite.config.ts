import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) {
            return 'monaco';
          }
          if (id.includes('@tauri-apps')) {
            return 'tauri';
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
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:31245',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:31245',
        ws: true,
      },
    },
  },
});
