import React, { Suspense, lazy } from 'react';
import { sanitizeDisplayText } from './displayText';

const MarkdownContent = lazy(() => import('./MarkdownContent'));

interface LazyMarkdownContentProps {
  content: string;
}

const MarkdownFallback: React.FC<LazyMarkdownContentProps> = ({ content }) => (
  <span className="agent-markdown-fallback">{sanitizeDisplayText(content)}</span>
);

const LazyMarkdownContent: React.FC<LazyMarkdownContentProps> = ({ content }) => (
  <Suspense fallback={<MarkdownFallback content={content} />}>
    <MarkdownContent content={content} />
  </Suspense>
);

export default LazyMarkdownContent;
