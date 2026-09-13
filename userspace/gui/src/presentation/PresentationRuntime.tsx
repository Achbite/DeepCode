import React, { useCallback, useMemo } from 'react';
import { projectCommittedText } from '@deepcode/presentation-core';
import type { SessionProjection } from '@deepcode/protocol';
import { MarkdownContent } from '../components/local-agent/BufferedMarkdown';

export interface PresentedCommittedContent {
  layoutKey: string;
  content(blockId: string): React.ReactNode;
}

export function usePresentedCommittedContent(projection: SessionProjection | null, locale: string): PresentedCommittedContent {
  const blocks = useMemo(() => projection ? projectCommittedText(projection) : new Map(), [projection?.sessionId, projection?.revision]);
  const rendered = useMemo(() => new Map<string, React.ReactNode>(), [blocks, locale]);
  const content = useCallback((blockId: string) => {
    if (!rendered.has(blockId)) {
      const block = blocks.get(blockId);
      if (!block) throw new Error(`presentation_text_missing:${blockId}`);
      rendered.set(blockId, block.format === 'plain'
        ? <div className="conversation-plain">{block.text}</div>
        : <MarkdownContent>{block.text}</MarkdownContent>);
    }
    return rendered.get(blockId);
  }, [blocks, rendered]);
  return { layoutKey: `${projection?.sessionId ?? 'empty'}:${projection?.revision ?? 0}:${locale}`, content };
}
