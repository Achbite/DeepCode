import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { sanitizeDisplayText } from './displayText';

interface MarkdownContentProps {
  content: string;
}

interface CodeElementProps {
  className?: string;
  children?: React.ReactNode;
}

let mermaidInitialized = false;

function normalizeMathChunk(chunk: string): string {
  return chunk
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => `$${expression.trim()}$`);
}

function normalizeMathDelimiters(source: string): string {
  const fencePattern = /```[\s\S]*?```/g;
  let cursor = 0;
  let result = '';
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(source)) !== null) {
    result += normalizeMathChunk(source.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }

  result += normalizeMathChunk(source.slice(cursor));
  return result;
}

function extractText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (React.isValidElement<CodeElementProps>(child)) return extractText(child.props.children);
      return '';
    })
    .join('');
}

async function renderMermaid(source: string, id: string): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      themeVariables: {
        background: '#131316',
        primaryColor: '#1c1c20',
        primaryTextColor: '#ededed',
        primaryBorderColor: '#2f7dd3',
        lineColor: '#6ea8ff',
        secondaryColor: '#111827',
        tertiaryColor: '#0f172a',
      },
    });
    mermaidInitialized = true;
  }

  const result = await mermaid.render(id, source);
  return result.svg;
}

function MermaidBlock({ source }: { source: string }) {
  const renderId = useMemo(
    () => `deepcode-mermaid-${Math.random().toString(36).slice(2)}`,
    []
  );
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    renderMermaid(source, renderId)
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) setError(message);
      });

    return () => {
      cancelled = true;
    };
  }, [renderId, source]);

  return (
    <div className="agent-mermaid-card" aria-label="Mermaid diagram">
      {svg ? (
        <div
          className="agent-mermaid-card__svg"
          // Mermaid returns sanitized SVG when securityLevel=strict.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <>
          <div className="agent-mermaid-card__title">
            {error ? 'Mermaid render failed' : 'Rendering diagram...'}
          </div>
          {error && <div className="agent-mermaid-card__empty">{error}</div>}
          <pre className="agent-markdown__code-block">
            <code>{source}</code>
          </pre>
        </>
      )}
    </div>
  );
}

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  return function MarkdownHeading({ node: _node, children, ...props }: React.ComponentPropsWithoutRef<'h1'> & { node?: unknown }) {
    const className = `agent-markdown__heading agent-markdown__heading--${level}`;
    if (level === 1) return <h3 {...props} className={className}>{children}</h3>;
    if (level === 2) return <h4 {...props} className={className}>{children}</h4>;
    return <h5 {...props} className={className}>{children}</h5>;
  };
}

const markdownComponents: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  a({ node: _node, href, children, ...props }) {
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  p({ node: _node, children, ...props }) {
    return (
      <p {...props} className="agent-markdown__paragraph">
        {children}
      </p>
    );
  },
  ul({ node: _node, children, ...props }) {
    return (
      <ul {...props} className="agent-markdown__list">
        {children}
      </ul>
    );
  },
  ol({ node: _node, children, ...props }) {
    return (
      <ol {...props} className="agent-markdown__list">
        {children}
      </ol>
    );
  },
  blockquote({ node: _node, children, ...props }) {
    return (
      <blockquote {...props} className="agent-markdown__quote">
        {children}
      </blockquote>
    );
  },
  hr({ node: _node, ...props }) {
    return <hr {...props} className="agent-markdown__hr" />;
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="agent-markdown__table-wrap">
        <table {...props} className="agent-markdown__table">
          {children}
        </table>
      </div>
    );
  },
  pre({ node: _node, children, ...props }) {
    const childArray = React.Children.toArray(children);
    const child = childArray.length === 1 ? childArray[0] : null;
    if (React.isValidElement<CodeElementProps>(child)) {
      const className = child.props.className ?? '';
      const language = /language-([^\s]+)/.exec(className)?.[1] ?? '';
      const code = extractText(child.props.children).replace(/\n$/, '');
      if (language.toLowerCase() === 'mermaid') {
        return <MermaidBlock source={code} />;
      }
      return (
        <pre {...props} className="agent-markdown__code-block">
          {language && <span className="agent-markdown__code-language">{language}</span>}
          <code className={className}>{code}</code>
        </pre>
      );
    }

    return (
      <pre {...props} className="agent-markdown__code-block">
        {children}
      </pre>
    );
  },
  code({ node: _node, className, children, ...props }) {
    return (
      <code {...props} className={className ? `${className} agent-markdown__code` : 'agent-markdown__inline-code'}>
        {children}
      </code>
    );
  },
};

const MarkdownContent: React.FC<MarkdownContentProps> = ({ content }) => {
  const markdown = useMemo(
    () => normalizeMathDelimiters(sanitizeDisplayText(content)),
    [content]
  );

  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
        skipHtml
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;
