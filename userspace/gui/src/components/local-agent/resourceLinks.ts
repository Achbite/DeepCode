import type { Element, ElementContent, Root, RootContent } from 'hast';

export function localReference(href: string): string | null {
  if (href.startsWith('file://')) {
    try {
      const url = new URL(href);
      return url.hostname && url.hostname !== 'localhost' ? null : decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  return /^(?:\/(?:[^/\s]+\/|[^\s]+\.[a-zA-Z0-9]+)|[A-Za-z]:[\\/])/u.test(href) ? href : null;
}
function label(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .at(-1) || path
  );
}
function link(path: string): Element {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: path, title: path },
    children: [{ type: 'text', value: label(path) }],
  };
}

/** Format references only. Original message text and tool records remain untouched. */
export function readableResourceLinks(tree: Root): Root {
  const visit = (node: RootContent): RootContent[] => {
    if (node.type === 'text') {
      const expression =
        /(?<![\w:/])(?:file:\/\/\/|\/(?=[^/\s]+\/)|[A-Za-z]:[\\/])[^\s<>"`，。；）)]+/gu;
      const result: RootContent[] = [];
      let start = 0;
      for (const match of node.value.matchAll(expression)) {
        const path = match[0].replace(/[.,;]+$/u, '');
        if (match.index! > start)
          result.push({ type: 'text', value: node.value.slice(start, match.index) });
        result.push(link(path));
        start = match.index! + path.length;
      }
      if (!result.length) return [node];
      if (start < node.value.length) result.push({ type: 'text', value: node.value.slice(start) });
      return result;
    }
    if (node.type !== 'element' || node.tagName === 'pre') return [node];
    if (node.tagName === 'a') {
      const href = String(node.properties.href ?? ''),
        path = localReference(href);
      const raw = node.children.every((child) => child.type === 'text')
        ? node.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
        : '';
      return [
        {
          ...node,
          properties: { ...node.properties, ...(path ? { title: path } : {}) },
          children:
            path && localReference(raw) ? [{ type: 'text', value: label(raw) }] : node.children,
        },
      ];
    }
    if (node.tagName === 'code') {
      const raw =
        node.children.length === 1 && node.children[0].type === 'text'
          ? node.children[0].value
          : '';
      return localReference(raw) ? [link(raw)] : [node];
    }
    return [{ ...node, children: node.children.flatMap(visit) as ElementContent[] }];
  };
  return { ...tree, children: tree.children.flatMap(visit) };
}
