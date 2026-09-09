import { useConversationHost, useConversationTheme } from './ConversationHost';
import { loadConversationMonaco } from './monacoRuntime';
import React, { memo, useEffect, useId, useState } from 'react';
import { useLocalAgentStore } from '../../state/localAgentStore';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

export const CodeContent = memo(function CodeContent({ code, language, streaming = false }: { code: string; language: string; streaming?: boolean }) {
  const host = useConversationHost();
  const theme = useConversationTheme();
  const [highlightError, setHighlightError] = useState('');
  const [rendered, setRendered] = useState<{ code: string; html: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(''), 1_500);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  useEffect(() => {
    if (streaming) return;
    let current = true;
    void loadConversationMonaco().then(async (monaco) => {
      monaco.editor.setTheme(theme);
      const html = await monaco.editor.colorize(code, language || 'plaintext', {});
      if (current) { setRendered({ code, html }); setHighlightError(''); }
    }).catch((error: unknown) => { if (current) { setRendered(null); setHighlightError(String(error)); } });
    return () => { current = false; };
  }, [code, language, theme, streaming]);
  return <div className="conversation-code">
    <header><span>{language || 'text'}</span><button type="button" className="conversation-copy-button" aria-label={copyStatus || '复制代码'} onClick={() => {
      setCopyStatus(''); setCopyError('');
      void host.copyText(code).then(() => setCopyStatus('已复制')).catch((error: unknown) => setCopyError(String(error)));
    }}><DeepCodeShellIcon name="copy" /><span className="conversation-copy-hint" role="status">{copyStatus || '复制代码'}</span></button></header>
    {copyError && <small className="conversation-copy-error" role="alert">{copyError}</small>}
    {highlightError && <small role="status">语法高亮不可用：{highlightError}</small>}
    {!streaming && rendered?.code === code
      ? <pre className="monaco-colorized"><code dangerouslySetInnerHTML={{ __html: rendered.html }} /></pre>
      : <pre><code>{code}</code></pre>}
  </div>;
});

export function ImageContent({ source, alt }: { source: string; alt: string }) {
  const { loadImage } = useConversationHost();
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const [result, setResult] = useState<{ source: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadImage(sessionId, source, controller.signal).then((image) => {
      if (controller.signal.aborted) { image.release?.(); return; }
      release = image.release;
      setResult({ source, url: image.url });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setResult({ source, error: String(error) }); });
    return () => { controller.abort(); release?.(); };
  }, [loadImage, sessionId, source]);
  if (result?.source !== source) return <span role="status">图片读取中…</span>;
  return result.url ? <img src={result.url} alt={alt} loading="lazy" onError={() => setResult({ source, error: '图片无法加载或解码。' })} />
    : <span role="status">{alt} · {result.error}</span>;
}

export function MermaidContent({ source }: { source: string }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [result, setResult] = useState<{ source: string; svg?: string; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
      const { svg } = await mermaid.render(id, source);
      if (current) setResult({ source, svg });
    }).catch((error: unknown) => { if (current) setResult({ source, error: String(error) }); });
    return () => { current = false; };
  }, [id, source]);
  return <figure className="conversation-diagram">
    {result?.source !== source ? <span role="status">图表渲染中…</span>
      : result.svg ? <div dangerouslySetInnerHTML={{ __html: result.svg }} />
        : <span role="status">图表未完整或无法渲染：{result.error}</span>}
    <details><summary>Mermaid 原文</summary><pre>{source}</pre></details>
  </figure>;
}
