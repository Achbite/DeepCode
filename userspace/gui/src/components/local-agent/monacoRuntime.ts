// Monaco ships standalone Workers in its installed package. Emit those assets
// directly, retaining all language services without rebuilding their compilers.
const workerAssets = import.meta.glob<string>(
  '/node_modules/monaco-editor/min/vs/assets/*.worker-*.js',
  { eager: true, query: '?url', import: 'default' },
);

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const kind = label === 'json' ? 'json'
      : ['css', 'scss', 'less'].includes(label) ? 'css'
        : ['html', 'handlebars', 'razor'].includes(label) ? 'html'
          : ['typescript', 'javascript'].includes(label) ? 'ts' : 'editor';
    const asset = Object.entries(workerAssets).find(([path]) => path.includes(`/${kind}.worker-`));
    if (!asset) throw new Error(`conversation_worker_missing:${kind}`);
    return new Worker(asset[1], { type: 'module' });
  },
};

export const loadConversationMonaco = () => import('monaco-editor');
