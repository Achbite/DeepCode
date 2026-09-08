import React, { memo, useEffect, useLayoutEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import {
  bufferedTypewriterDelay,
  bufferedTypewriterNextIndex,
  type BufferedTypewriterSpeed,
} from '../../utils/typewriterBuffer';

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

export const MarkdownContent = memo(function MarkdownContent({
  children,
}: {
  children: string;
}) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
      {children}
    </ReactMarkdown>
  );
});

export const BufferedMarkdown = memo(function BufferedMarkdown({
  text,
  streamIdentity,
  speed = 'normal',
  initialVisibleLength = 0,
  onVisibleLengthChange,
  onCaughtUp,
}: {
  text: string;
  streamIdentity: string;
  speed?: BufferedTypewriterSpeed;
  initialVisibleLength?: number;
  onVisibleLengthChange?(streamIdentity: string, visibleLength: number): void;
  onCaughtUp?(streamIdentity: string): void;
}) {
  const initialLength = boundedVisibleLength(initialVisibleLength, text.length);
  const [cursor, setCursor] = useState(() => ({
    streamIdentity,
    visibleLength: initialLength,
  }));
  const visibleLength = cursor.streamIdentity === streamIdentity
    ? Math.min(cursor.visibleLength, text.length)
    : initialLength;

  useEffect(() => {
    if (
      cursor.streamIdentity === streamIdentity
      && cursor.visibleLength <= text.length
    ) return;
    setCursor({ streamIdentity, visibleLength });
  }, [cursor.streamIdentity, cursor.visibleLength, streamIdentity, text.length, visibleLength]);

  useLayoutEffect(() => {
    onVisibleLengthChange?.(streamIdentity, visibleLength);
  }, [onVisibleLengthChange, streamIdentity, visibleLength]);

  useEffect(() => {
    if (visibleLength >= text.length) return;
    const timer = window.setTimeout(() => {
      setCursor((current) => {
        const currentLength = current.streamIdentity === streamIdentity
          ? Math.min(current.visibleLength, text.length)
          : initialLength;
        return {
          streamIdentity,
          visibleLength: bufferedTypewriterNextIndex(text, currentLength, speed),
        };
      });
    }, bufferedTypewriterDelay(speed));
    return () => window.clearTimeout(timer);
  }, [initialLength, speed, streamIdentity, text, visibleLength]);

  useEffect(() => {
    if (visibleLength >= text.length) onCaughtUp?.(streamIdentity);
  }, [onCaughtUp, streamIdentity, text.length, visibleLength]);

  const visibleText = text.slice(0, visibleLength);
  return <MarkdownContent>{visibleText}</MarkdownContent>;
});

function boundedVisibleLength(value: number, textLength: number): number {
  return Math.max(0, Math.min(value, textLength));
}
