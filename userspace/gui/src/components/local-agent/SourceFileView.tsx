import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import { loadCodeLanguage } from './codeLanguage';
import { codeViewerExtensions } from './codeViewer';
import { readViewState, saveViewState } from './readerState';
import { useConversationTheme } from './ConversationHost';

interface SourceViewState { anchor: number; head: number; top: number; left: number }

/** File contents stay literal, including Markdown and HTML. */
export default function SourceFileView({ content, filename, startLine = 1, column = 1, viewKey, wrap = true }: {
  content: string; filename: string; startLine?: number; column?: number; viewKey: string; wrap?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const wrapping = useRef(new Compartment());
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const [error, setError] = useState('');
  const theme = useConversationTheme();
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    setError('');
    void loadCodeLanguage('', filename).then((language) => {
      if (disposed || !surface.current) return;
      const saved = readViewState<SourceViewState | null>(viewKey + ':source', null);
      const position = (offset: number) => Math.max(0, Math.min(offset, content.length));
      const view = new EditorView({
        parent: surface.current,
        state: EditorState.create({
          doc: content,
          selection: saved ? { anchor: position(saved.anchor), head: position(saved.head) } : { anchor: Math.min(position(column - 1), content.split("\n", 1)[0].length) },
          extensions: [codeViewerExtensions(language, theme === 'vs-dark', startLine),
            EditorView.contentAttributes.of({ 'aria-label': filename }),
            wrapping.current.of(wrapRef.current ? EditorView.lineWrapping : [])],
        }),
      });
      editorRef.current = view;
      const frame = requestAnimationFrame(() => {
        if (saved) { view.scrollDOM.scrollTop = saved.top; view.scrollDOM.scrollLeft = saved.left; }
      });
      release = () => {
        cancelAnimationFrame(frame);
        const { anchor, head } = view.state.selection.main;
        saveViewState(viewKey + ':source', { anchor, head, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft });
        editorRef.current = null;
        view.destroy();
      };
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; release?.(); };
  }, [content, filename, startLine, column, theme, viewKey]);
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
    view.dispatch({ effects: [wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []), EditorView.scrollIntoView(top, { y: 'start' })] });
  }, [wrap]);
  return error ? <p role="alert">{error}</p> : <div ref={surface} className="reader-source-editor" />;
}
