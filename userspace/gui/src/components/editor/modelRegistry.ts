import type { editor as MonacoEditor } from 'monaco-editor';

const modelCache = new Map<string, MonacoEditor.ITextModel>();

export function registerModel(modelKey: string, model: MonacoEditor.ITextModel | null): void {
  if (!model) return;
  modelCache.set(modelKey, model);
}

export function closeModel(modelKey: string): void {
  const model = modelCache.get(modelKey);
  if (!model) return;
  model.dispose();
  modelCache.delete(modelKey);
}
