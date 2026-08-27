import React, { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  bufferedTypewriterDelay,
  bufferedTypewriterNextIndex,
  type BufferedTypewriterSpeed,
} from '../../utils/typewriterBuffer';

const REMARK_PLUGINS = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({
  children,
}: {
  children: string;
}) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{children}</ReactMarkdown>;
});

export const BufferedMarkdown = memo(function BufferedMarkdown({
  text,
  streamIdentity,
  speed = 'normal',
}: {
  text: string;
  streamIdentity: string;
  speed?: BufferedTypewriterSpeed;
}) {
  const [visibleLength, setVisibleLength] = useState(0);

  useEffect(() => {
    setVisibleLength(0);
  }, [streamIdentity]);

  useEffect(() => {
    if (visibleLength >= text.length) return;
    const timer = window.setTimeout(() => {
      setVisibleLength((current) => bufferedTypewriterNextIndex(text, current, speed));
    }, bufferedTypewriterDelay(speed));
    return () => window.clearTimeout(timer);
  }, [speed, text, visibleLength]);

  const visibleText = text.slice(0, Math.min(visibleLength, text.length));
  return <MarkdownContent>{visibleText}</MarkdownContent>;
});
