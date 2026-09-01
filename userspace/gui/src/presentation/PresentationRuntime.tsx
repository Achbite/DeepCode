import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import {
  PresentationRendererRegistry,
  projectSessionPresentation,
  type PresentationRendererRegistrySnapshot,
} from '@deepcode/presentation-core';
import type {
  PresentationArtifactBlock,
  PresentationBlock,
  PresentationBlockKind,
  PresentationContentResolution,
  PresentationLinkBlock,
  PresentationProviderPort,
  PresentationRenderContext,
  PresentationRendererDescriptor,
  SessionProjection,
} from '@deepcode/protocol';
import { MarkdownContent } from '../components/local-agent/BufferedMarkdown';

const GUI_PRESENTATION_BLOCK_KINDS = [
  'text',
  'group',
  'section',
  'code',
  'keyValue',
  'status',
  'link',
  'artifact',
  'action',
] as const satisfies readonly [PresentationBlockKind, ...PresentationBlockKind[]];

export type GuiPresentationRenderer = PresentationProviderPort<React.ReactNode>;
export type GuiPresentationRegistry = PresentationRendererRegistry<React.ReactNode>;

class GuiBuiltinPresentationRenderer implements GuiPresentationRenderer {
  describeRenderer(): PresentationRendererDescriptor {
    return {
      rendererId: 'deepcode.gui.presentation.builtin',
      contributionRef: 'coreBuiltin:gui-presentation',
      origin: 'builtin',
      supportedBlockKinds: GUI_PRESENTATION_BLOCK_KINDS,
    };
  }

  prepareRenderer(): void {}

  supportsBlockKind(kind: PresentationBlockKind): boolean {
    return GUI_PRESENTATION_BLOCK_KINDS.includes(kind);
  }

  renderPresentationBlock(
    block: PresentationBlock,
    _context?: PresentationRenderContext,
  ): React.ReactNode {
    return renderBuiltinBlock(block);
  }

  async resolveContentLink(
    block: PresentationLinkBlock | PresentationArtifactBlock,
  ): Promise<PresentationContentResolution> {
    if (block.uri) return { status: 'resolved', uri: block.uri };
    return {
      status: 'unavailable',
      error: {
        code: 'presentation_content_unavailable',
        message: `Presentation block ${block.blockId} does not expose a URI.`,
      },
    };
  }

  disposeRenderer(): void {}
}

function renderBuiltinBlock(block: PresentationBlock): React.ReactNode {
  switch (block.kind) {
    case 'text':
      return <MarkdownContent>{block.text}</MarkdownContent>;
    case 'group':
      return (
        <div className="local-agent__presentation-group">
          {block.label && <strong>{block.label}</strong>}
          {block.children.map((child) => (
            <React.Fragment key={child.blockId}>{renderBuiltinBlock(child)}</React.Fragment>
          ))}
        </div>
      );
    case 'section':
      return (
        <section className="local-agent__presentation-section">
          {block.title && <strong>{block.title}</strong>}
          {block.children.map((child) => (
            <React.Fragment key={child.blockId}>{renderBuiltinBlock(child)}</React.Fragment>
          ))}
        </section>
      );
    case 'code':
      return (
        <div className="local-agent__presentation-code">
          {block.label && <strong>{block.label}</strong>}
          <pre><code>{block.code}</code></pre>
        </div>
      );
    case 'keyValue':
      return (
        <dl className="local-agent__presentation-key-value">
          {block.entries.map((entry, index) => (
            <React.Fragment key={`${entry.key}:${index}`}>
              <dt>{entry.key}</dt>
              <dd>{entry.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      );
    case 'status':
      return (
        <div className="local-agent__presentation-status" data-state={block.state}>
          <strong>{block.label}</strong>
          {block.detail && <span>{block.detail}</span>}
        </div>
      );
    case 'link':
      return <a href={block.uri}>{block.label}</a>;
    case 'artifact':
      return <span>{block.label}</span>;
    case 'action':
      return <button type="button" disabled>{block.label}</button>;
  }
}

const GuiPresentationContext = createContext<GuiPresentationRegistry | null>(null);

export function createGuiPresentationRegistry(): GuiPresentationRegistry {
  return new PresentationRendererRegistry(new GuiBuiltinPresentationRenderer());
}

export const GuiPresentationProvider: React.FC<{
  registry: GuiPresentationRegistry;
  children: React.ReactNode;
}> = ({ registry, children }) => (
  <GuiPresentationContext.Provider value={registry}>
    {children}
  </GuiPresentationContext.Provider>
);

export function useGuiPresentationRegistry(): GuiPresentationRegistry {
  const registry = useContext(GuiPresentationContext);
  if (!registry) throw new Error('gui_presentation_registry_unavailable');
  return registry;
}

export interface PresentedCommittedContent {
  registry: GuiPresentationRegistry;
  snapshot: PresentationRendererRegistrySnapshot;
  content(blockId: string): React.ReactNode;
}

export function usePresentedCommittedContent(
  projection: SessionProjection | null,
  locale: string,
): PresentedCommittedContent {
  const registry = useGuiPresentationRegistry();
  const [snapshot, setSnapshot] = useState(() => registry.snapshot());

  useEffect(() => {
    setSnapshot(registry.snapshot());
    return registry.subscribe(setSnapshot);
  }, [registry]);

  const inputBlocks = useMemo(() => {
    if (!projection) return [];
    return committedContentBlocks(projectSessionPresentation(projection));
  }, [projection]);
  const renderKey = projection
    ? `${projection.sessionId}:${projection.revision}:${snapshot.revision}:${locale}`
    : `empty:${snapshot.revision}:${locale}`;
  const [rendered, setRendered] = useState<{
    key: string;
    nodes: ReadonlyMap<string, React.ReactNode>;
  } | null>(null);

  useLayoutEffect(() => {
    const nodes = new Map<string, React.ReactNode>();
    for (const block of inputBlocks) {
      const output = registry.render([block], { locale }).at(-1);
      if (output !== undefined) nodes.set(block.blockId, output);
    }
    setRendered({ key: renderKey, nodes });
  }, [inputBlocks, locale, registry, renderKey]);

  const content = useCallback((blockId: string) => {
    if (rendered?.key !== renderKey) return null;
    return rendered.nodes.get(blockId);
  }, [renderKey, rendered]);

  return { registry, snapshot, content };
}

function committedContentBlocks(blocks: readonly PresentationBlock[]): PresentationBlock[] {
  const selected: PresentationBlock[] = [];
  for (const block of blocks) collectCommittedContentBlock(block, selected);
  return selected;
}

function collectCommittedContentBlock(
  block: PresentationBlock,
  selected: PresentationBlock[],
): void {
  if (
    block.kind === 'text'
    && (block.source.kind === 'message' || block.source.kind === 'narrative')
  ) {
    selected.push(block);
    return;
  }
  if (block.kind === 'group' || block.kind === 'section') {
    for (const child of block.children) collectCommittedContentBlock(child, selected);
  }
}
