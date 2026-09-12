import React, { useEffect, useState } from 'react';
import { useConversationHost } from './ConversationHost';
import type { JsonObject } from '@deepcode/protocol';
import { useConversationRowState } from './ConversationVirtualRow';

export function ReasoningDetails({ sessionId, requestId, live = false, summary }: { sessionId: string; requestId: string; live?: boolean; summary?: React.ReactNode }) {
  const { readConversation } = useConversationHost();
  const [open, setOpen] = useConversationRowState(`reasoning:${requestId}:open`, false);
  const [page, setPage] = useConversationRowState<JsonObject | null>(`reasoning:${requestId}:page`, null);
  const [offset, setOffset] = useConversationRowState(`reasoning:${requestId}:offset`, 0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await readConversation(sessionId, { view: 'reasoning', providerRequestId: requestId, offset }, controller.signal);
        if (!controller.signal.aborted) { setPage(result.items[0] ?? null); setError(''); }
      } catch (error) { if (!controller.signal.aborted) setError(String(error)); }
      if (live && !controller.signal.aborted) timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [readConversation, sessionId, requestId, live, open, offset]);
  return <details className="conversation-reasoning" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{summary ?? (live ? '正在推理' : '查看本次推理')}<span className="conversation-disclosure-chevron" aria-hidden="true">⌄</span></summary>
    {open && <div className="conversation-reasoning-body" tabIndex={0}>{error ? <p role="alert">{error}</p> : !page ? <span>读取中…</span> : <>
      {Array.isArray(page.parts) && page.parts.map((part, index) => part && typeof part === 'object' && !Array.isArray(part)
        ? <section key={index}><small>{part.kind === 'summary' ? 'Provider 推理摘要' : 'Provider 推理文本'}</small><pre>{String(part.content)}</pre></section> : null)}
      {Array.isArray(page.parts) && !page.parts.length && <span>Provider 尚未提供可展示内容。</span>}
      {page.truncated === true && <small>{live ? '显示最近的有界内容；完成后可分页读取历史。' : '当前内容未读完。'}</small>}
      {!live && offset > 0 && <button type="button" onClick={() => setOffset(0)}>回到开头</button>}
      {!live && typeof page.nextOffset === 'number' && <button type="button" onClick={() => setOffset(Number(page.nextOffset))}>下一段</button>}
    </>}</div>}
  </details>;
}

export function ReasoningHistory({ sessionId, runId }: { sessionId: string; runId: string }) {
  const { readConversation } = useConversationHost();
  const [items, setItems] = useState<JsonObject[]>([]);
  const [before, setBefore] = useState<number | undefined>();
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void readConversation(sessionId, { view: 'reasoning', limit: 50, ...(before ? { before } : {}) }, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setItems(result.items); setNext(result.nextBefore); setError(''); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [readConversation, sessionId, runId, before]);
  return <>{error && <p role="alert">{error}</p>}{items.filter((item) => item.runId === runId
    && Array.isArray(item.kinds) && item.kinds.length).map((item) => <ReasoningDetails key={String(item.providerRequestId)} sessionId={sessionId} requestId={String(item.providerRequestId)} />)}
    {next !== null && <button type="button" onClick={() => setBefore(next)}>较早的推理记录</button>}</>;
}
