import React, { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { CodeContent, ImageContent, MermaidContent } from './RichContent';
import { StreamingMarkdownParser, type MarkdownBlock } from './streamingMarkdown';
import './richContent.css';
import 'katex/dist/katex.min.css';

const StreamingContext = createContext(false);
const COMPONENTS = {
  pre: function MarkdownCode({ children }: { children?: React.ReactNode }) {
    const streaming = useContext(StreamingContext);
    const child = React.Children.toArray(children)[0];
    if (!React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) return <pre>{children}</pre>;
    const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? '';
    const code = String(child.props.children ?? '');
    return language === 'mermaid' && !streaming
      ? <MermaidContent source={code} /> : <CodeContent code={code} language={language} streaming={streaming} />;
  },
  table: function MarkdownTable({ children }: { children?: React.ReactNode }) { return <div className="conversation-table"><table>{children}</table></div>; },
  img: function MarkdownImage({ src, alt }: { src?: string; alt?: string }) { return <ImageContent source={src ?? ''} alt={alt ?? ''} />; },
};

const RenderedBlock = memo(function RenderedBlock({ block }: { block: MarkdownBlock }) {
  return <StreamingContext.Provider value={block.streaming}>{toJsxRuntime(block.tree, { Fragment, jsx, jsxs, components: COMPONENTS })}</StreamingContext.Provider>;
});

export const MarkdownContent = memo(function MarkdownContent({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const parser = useRef(new StreamingMarkdownParser());
  const blocks = useMemo(() => parser.current.update(children, streaming), [children, streaming]);
  return <div className="conversation-markdown">{blocks.map((block) => <RenderedBlock key={block.key} block={block} />)}</div>;
});

/** Coalesce real deltas once per frame; do not put another typewriter queue behind the Provider. */
export const BufferedMarkdown = memo(function BufferedMarkdown({ text, streamIdentity, streaming = true, onDisplayed }: {
  text: string;
  streamIdentity: string;
  streaming?: boolean;
  onDisplayed?(identity: string, text: string): void;
}) {
  const [visible, setVisible] = useState({ identity: streamIdentity, text });
  const latest = useRef({ identity: streamIdentity, text });
  const frame = useRef<number | null>(null);
  useLayoutEffect(() => {
    latest.current = { identity: streamIdentity, text };
    if (visible.identity === streamIdentity && visible.text === text || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; setVisible(latest.current); });
  }, [streamIdentity, text, visible]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const displayed = visible.identity === streamIdentity ? visible.text : text;
  const caughtUp = displayed === text;
  useLayoutEffect(() => {
    if (!streaming && caughtUp) onDisplayed?.(streamIdentity, displayed);
  }, [streaming, caughtUp, streamIdentity, displayed, onDisplayed]);
  return <MarkdownContent streaming={streaming || !caughtUp}>{displayed}</MarkdownContent>;
});
