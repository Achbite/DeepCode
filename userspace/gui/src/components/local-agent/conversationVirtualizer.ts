interface RowLayout {
  height?: number;
  state: Map<string, unknown>;
}

/** UI measurements and disclosure state, scoped to the recently visited sessions. */
export class ConversationLayoutCache {
  private sessions = new Map<string, Map<string, RowLayout>>();

  session(id: string): Map<string, RowLayout> {
    const rows = this.sessions.get(id) ?? new Map<string, RowLayout>();
    this.sessions.delete(id);
    this.sessions.set(id, rows);
    while (this.sessions.size > 6) this.sessions.delete(this.sessions.keys().next().value!);
    return rows;
  }
}

interface ObservedRow {
  node: HTMLElement;
  show(visible: boolean): void;
  nearby: boolean;
}

/** Keep every anchor in the scroll surface; only its expensive content is virtual. */
export class ConversationVirtualizer {
  private rows = new Map<string, ObservedRow>();
  private intersection: IntersectionObserver | null = null;
  private resize: ResizeObserver | null = null;
  private connected = false;
  private body: HTMLElement | null = null;

  constructor(private layouts: Map<string, RowLayout>, private onLayout: () => void) {}

  layout(key: string): RowLayout {
    let layout = this.layouts.get(key);
    if (!layout) { layout = { state: new Map() }; this.layouts.set(key, layout); }
    return layout;
  }

  connect(body: HTMLElement): void {
    this.connected = true;
    this.body = body;
    this.intersection = new IntersectionObserver((entries) => {
      if (!this.connected) return;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const row = this.rows.get(node.dataset.conversationAnchor!);
        if (!row || row.node !== node || node.hidden) continue;
        row.nearby = entry.isIntersecting;
        this.updateVisibility(row);
      }
    }, { root: body, rootMargin: '800px 0px' });
    this.resize = new ResizeObserver((entries) => {
      if (!this.connected) return;
      for (const entry of entries) this.measure(entry.target as HTMLElement);
    });
    body.addEventListener('focusout', this.interactionEnded);
    body.ownerDocument.addEventListener('selectionchange', this.interactionEnded);
    for (const { node } of this.rows.values()) this.observe(node);
  }

  register(key: string, node: HTMLElement, show: ObservedRow['show']): () => void {
    this.rows.set(key, { node, show, nearby: true });
    this.observe(node);
    return () => {
      this.intersection?.unobserve(node);
      this.resize?.unobserve(node);
      if (this.rows.get(key)?.node === node) this.rows.delete(key);
    };
  }

  measure(node: HTMLElement): void {
    if (node.hidden || node.dataset.virtualRendered !== 'true') return;
    const layout = this.layout(node.dataset.conversationAnchor!);
    const height = node.getBoundingClientRect().height;
    if (layout.height === height) return;
    layout.height = height;
    this.onLayout();
  }

  disconnect(): void {
    this.connected = false;
    this.body?.removeEventListener('focusout', this.interactionEnded);
    this.body?.ownerDocument.removeEventListener('selectionchange', this.interactionEnded);
    this.body = null;
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.intersection = null;
    this.resize = null;
  }

  private interactionEnded = (): void => {
    queueMicrotask(() => {
      if (this.connected) for (const row of this.rows.values()) {
        if (!row.nearby) this.updateVisibility(row);
      }
    });
  };

  private updateVisibility(row: ObservedRow): void {
    const { node } = row;
    const selection = node.ownerDocument.getSelection();
    const interacting = node.contains(node.ownerDocument.activeElement)
      || Boolean(selection && !selection.isCollapsed
        && (node.contains(selection.anchorNode) || node.contains(selection.focusNode)));
    // Keep keyboard focus and selected text alive, then release offscreen content.
    if (!row.nearby && interacting) return;
    row.show(row.nearby);
  }

  private observe(node: HTMLElement): void {
    if (node.hidden) return;
    this.intersection?.observe(node);
    this.resize?.observe(node);
    this.measure(node);
  }
}
