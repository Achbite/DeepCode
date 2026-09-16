import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  base: './', plugins: [react()],
  build: { outDir: '../../docs/task-receipts/composer-browser-20260916/preview', emptyOutDir: true,
    rollupOptions: { input: {
      composer: fileURLToPath(new URL('./composer.html', import.meta.url)),
      viewport: fileURLToPath(new URL('./viewport.html', import.meta.url)),
    } } },
});
