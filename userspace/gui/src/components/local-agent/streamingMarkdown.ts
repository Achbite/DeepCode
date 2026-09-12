import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import { defaultUrlTransform } from 'react-markdown';
import type { Root as MarkdownRoot } from 'mdast';
import type { Root, RootContent } from 'hast';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const converter = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypeKatex);
export interface MarkdownBlock { key: string; tree: Root; streaming: boolean }

function renderTree(root: MarkdownRoot): Root {
  const tree = converter.runSync(root) as Root;
  // Preserve react-markdown's literal HTML and URL policy with the same grammar.
  const clean = (node: Root | RootContent): void => {
    if (node.type === 'raw') { Object.assign(node, { type: 'text' }); return; }
    if (node.type === 'element') {
      for (const name of ['href', 'src']) {
        const value = node.properties[name];
        if (typeof value === 'string') node.properties[name] = /^workspace:\/\/[^/]+\/.+/.test(value)
          ? value : defaultUrlTransform(value);
      }
    }
    if ('children' in node) node.children.forEach(clean);
  };
  clean(tree);
  return tree;
}

const completedDocuments = new Map<string, MarkdownBlock[]>();
let completedCharacters = 0;

function fullBlocks(text: string, cache = true): MarkdownBlock[] {
  const cached = cache ? completedDocuments.get(text) : undefined;
  if (cached) {
    completedDocuments.delete(text);
    completedDocuments.set(text, cached);
    return cached;
  }
  const blocks = renderTree(parser.parse(text)).children.flatMap((node, index) => {
    if (node.type === 'text' && !node.value.trim()) return [];
    return [{ key: String(node.position?.start.offset ?? `generated:${index}`), tree: { type: 'root' as const, children: [node] }, streaming: false }];
  });
  // Cache parsed display content across component remounts, with a bounded LRU.
  // Live tails bypass this cache; reference-bearing streams reconcile separately.
  if (cache && text.length <= 500_000) {
    completedDocuments.set(text, blocks);
    completedCharacters += text.length;
    while (completedDocuments.size > 128 || completedCharacters > 500_000) {
      const oldest = completedDocuments.keys().next().value!;
      completedCharacters -= oldest.length;
      completedDocuments.delete(oldest);
    }
  }
  return blocks;
}

/** Only the parser-confirmed prefix freezes. Lists, tables and open fences stay in the tail. */
export class StreamingMarkdownParser {
  private text = '';
  private offset = 0;
  private frozen: MarkdownBlock[] = [];
  private blocks: MarkdownBlock[] = [];
  private streaming = true;
  private documentReferences = false;

  update(text: string, streaming: boolean): MarkdownBlock[] {
    if (this.text === text && this.streaming === streaming) return this.blocks;
    if (!text.startsWith(this.text)) {
      this.offset = 0; this.frozen = []; this.documentReferences = false;
    }
    this.text = text; this.streaming = streaming;
    if (!streaming) { this.blocks = fullBlocks(text); return this.blocks; }
    const root = parser.parse(text.slice(this.offset));
    // Definitions have document-wide meaning. Reconcile those documents as a whole.
    if (root.children.some((node) => node.type === 'definition' || node.type === 'footnoteDefinition')) this.documentReferences = true;
    if (this.documentReferences) {
      this.offset = 0; this.frozen = [];
      this.blocks = fullBlocks(text, false).map((block) => ({ ...block, streaming: true }));
      return this.blocks;
    }
    const base = this.offset;
    const freezeCount = Math.max(0, root.children.length - 2);
    const tail = root.children.map((node, index): MarkdownBlock => ({
      key: String(base + node.position!.start.offset!),
      tree: renderTree({ type: 'root', children: [node] }),
      streaming: index >= freezeCount,
    }));
    this.blocks = [...this.frozen, ...tail];
    if (freezeCount > 0) {
      this.frozen = [...this.frozen, ...tail.slice(0, freezeCount)];
      this.offset = base + root.children[freezeCount - 1]!.position!.end.offset!;
    }
    return this.blocks;
  }
}
