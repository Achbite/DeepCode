import React from 'react';
import { sanitizeDisplayText } from './displayText';

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\\\([^)]+\\\)|\$[^$\n]+\$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    const key = `${match.index}:${token}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('\\(')) {
      nodes.push(<span key={key} className="agent-markdown__math-inline">{token.slice(2, -2)}</span>);
    } else if (token.startsWith('$')) {
      nodes.push(<span key={key} className="agent-markdown__math-inline">{token.slice(1, -1)}</span>);
    } else {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          <a key={key} href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>
        );
      }
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes.length > 0 ? nodes : [text];
}

function isMarkdownBlock(line: string): boolean {
  return (
    /^#{1,4}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\$\$\s*$/.test(line.trim()) ||
    /^```/.test(line)
  );
}

function renderMathBlock(content: string, key: string): React.ReactNode {
  return (
    <div key={key} className="agent-markdown__math-block" aria-label="Math formula">
      <span>{content.trim()}</span>
    </div>
  );
}

interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

function cleanMermaidNode(value: string): string {
  return value
    .trim()
    .replace(/["'`]/g, '')
    .replace(/\[\s*([^\]]+)\s*\]/g, '$1')
    .replace(/\(\s*([^)]+)\s*\)/g, '$1')
    .replace(/\{\s*([^}]+)\s*\}/g, '$1')
    .replace(/^([A-Za-z0-9_-]+)\s*(.+)$/, (_all, id, label) => label?.trim() || id)
    .trim();
}

function parseMermaidEdges(lines: string[]): MermaidEdge[] {
  const edges: MermaidEdge[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^%%/.test(line) || /^(flowchart|graph)\s+/i.test(line)) continue;
    const edgeMatch = /^(.+?)\s*(?:-->|---|==>|-.->)\s*(?:\|([^|]+)\|\s*)?(.+)$/.exec(line);
    if (edgeMatch) {
      edges.push({
        from: cleanMermaidNode(edgeMatch[1]),
        label: edgeMatch[2]?.trim(),
        to: cleanMermaidNode(edgeMatch[3]),
      });
      continue;
    }
    const sequenceMatch = /^(.+?)\s*(?:->>|-->>|->|-->)\s*(.+?)(?::\s*(.+))?$/.exec(line);
    if (sequenceMatch) {
      edges.push({
        from: cleanMermaidNode(sequenceMatch[1]),
        to: cleanMermaidNode(sequenceMatch[2]),
        label: sequenceMatch[3]?.trim(),
      });
    }
  }
  return edges;
}

function renderMermaidDiagram(code: string, key: string): React.ReactNode {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const title = lines.find((line) => line.trim())?.trim() ?? 'Mermaid diagram';
  const edges = parseMermaidEdges(lines);

  return (
    <div key={key} className="agent-mermaid-card" aria-label="Mermaid diagram">
      <div className="agent-mermaid-card__title">{title}</div>
      {edges.length > 0 ? (
        <div className="agent-mermaid-card__edges">
          {edges.map((edge, edgeIndex) => (
            <div key={`${edge.from}-${edge.to}-${edgeIndex}`} className="agent-mermaid-edge">
              <span className="agent-mermaid-edge__node">{edge.from}</span>
              <span className="agent-mermaid-edge__arrow">{'->'}</span>
              {edge.label && <span className="agent-mermaid-edge__label">{edge.label}</span>}
              <span className="agent-mermaid-edge__node">{edge.to}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="agent-mermaid-card__empty">Diagram source detected. No supported edges found.</div>
      )}
    </div>
  );
}

interface MarkdownContentProps {
  content: string;
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({ content }) => {
  const lines = sanitizeDisplayText(content).replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let index = 0;

  const readParagraph = () => {
    const items: string[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim() || isMarkdownBlock(line)) break;
      items.push(line.trim());
      index += 1;
    }
    return items;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      if (language.toLowerCase() === 'mermaid') {
        blocks.push(renderMermaidDiagram(codeLines.join('\n'), `mermaid-${index}`));
        continue;
      }
      blocks.push(
        <pre key={`code-${index}`} className="agent-markdown__code-block">
          {language && <span className="agent-markdown__code-language">{language}</span>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    if (/^\$\$\s*$/.test(trimmed)) {
      const mathLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\$\$\s*$/.test(lines[index].trim())) {
        mathLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(renderMathBlock(mathLines.join('\n'), `math-${index}`));
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const className = `agent-markdown__heading agent-markdown__heading--${level}`;
      const body = renderInlineMarkdown(heading[2]);
      if (level === 1) {
        blocks.push(<h3 key={`h-${index}`} className={className}>{body}</h3>);
      } else if (level === 2) {
        blocks.push(<h4 key={`h-${index}`} className={className}>{body}</h4>);
      } else {
        blocks.push(<h5 key={`h-${index}`} className={className}>{body}</h5>);
      }
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, '').trim());
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="agent-markdown__list">
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}:${item}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, '').trim());
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="agent-markdown__list">
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}:${item}`}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, '').trim());
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`} className="agent-markdown__quote">
          {renderInlineMarkdown(quoteLines.join(' '))}
        </blockquote>
      );
      continue;
    }

    const paragraph = readParagraph();
    if (paragraph.length > 0) {
      blocks.push(
        <p key={`p-${index}`} className="agent-markdown__paragraph">
          {renderInlineMarkdown(paragraph.join(' '))}
        </p>
      );
      continue;
    }

    blocks.push(
      <p key={`p-${index}`} className="agent-markdown__paragraph">
        {renderInlineMarkdown(trimmed)}
      </p>
    );
    index += 1;
  }

  return <div className="agent-markdown">{blocks}</div>;
};

export default MarkdownContent;
