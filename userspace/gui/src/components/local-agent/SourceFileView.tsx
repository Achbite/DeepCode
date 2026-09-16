import type { editor as MonacoEditor } from 'monaco-editor';
import React, { useEffect, useRef, useState } from 'react';
import { loadConversationMonaco } from './monacoRuntime';
import { readViewState, saveViewState } from './readerState';
import { useConversationTheme } from './ConversationHost';

/** File contents stay literal, including Markdown and HTML. */
export default function SourceFileView({ content, filename, startLine = 1, column = 1, viewKey, wrap = true }: {
  content: string; filename: string; startLine?: number; column?: number; viewKey: string; wrap?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const [error, setError] = useState('');
  const theme = useConversationTheme();
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    setError('');
    void loadConversationMonaco().then((monaco) => {
      if (disposed || !surface.current) return;
      const name = filename.split(/[\\/]/).at(-1) ?? filename;
      const dot = name.lastIndexOf('.');
      const extension = dot < 0 ? '' : name.slice(dot).toLowerCase();
      const language = monaco.languages.getLanguages().find((item) => item.filenames?.includes(name)
        || extension && item.extensions?.includes(extension))?.id ?? 'plaintext';
      const model = monaco.editor.createModel(content, language);
      const editor = monaco.editor.create(surface.current, { model, theme, readOnly: true, domReadOnly: true,
        automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
        fontSize: 13, wordWrap: wrapRef.current ? 'on' : 'off', wrappingIndent: 'same',
        lineNumbers: (line) => String(startLine + line - 1),
        ariaLabel: filename, renderLineHighlight: 'none', contextmenu: true });
      editorRef.current = editor;
      const saved = readViewState<ReturnType<typeof editor.saveViewState>>(viewKey + ':editor', null);
      if (saved) editor.restoreViewState(saved);
      else editor.setPosition({ lineNumber: 1, column });
      release = () => { saveViewState(viewKey + ':editor', editor.saveViewState()); editorRef.current = null; editor.dispose(); model.dispose(); };
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; release?.(); };
  }, [content, filename, startLine, column, theme, viewKey]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const visible = editor.getVisibleRanges()[0];
    editor.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
    if (visible) editor.revealLineNearTop(visible.startLineNumber);
  }, [wrap]);
  return error ? <p role="alert">{error}</p> : <div ref={surface} className="reader-source-editor" />;
}
