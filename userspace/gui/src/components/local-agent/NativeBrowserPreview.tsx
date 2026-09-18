import { isInterfaceReloading } from '../../services/interfaceReload';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  nativeBrowserCommand,
  nativeHostBinding,
  listenNativePages,
  nativeNavigationInput,
  type NativeHostBinding,
  type NativePage,
} from '../../services/nativeBrowser';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { type BrowserAnnotation, type BrowserReviewEdit } from './browserReview';

export function NativeBrowserPreview({
  sessionId,
  active,
  onClose,
  onReady,
  initialUrl,
  initialPath,
  initialPreviewId,
  selfPreview,
  onReview,
  reviewEdit,
}: {
  sessionId: string;
  active: boolean;
  onClose(): void;
  onReady(page: NativePage, binding: NativeHostBinding): void;
  initialUrl?: string;
  initialPath?: string;
  initialPreviewId?: string;
  selfPreview?: boolean;
  onReview?: (annotation: BrowserAnnotation, previewId: string, screenshot?: string) => void;
  reviewEdit?: BrowserReviewEdit | null;
}) {
  const callbacks = useRef({ onClose, onReady, onReview });
  callbacks.current = { onClose, onReady, onReview };
  const surface = useRef<HTMLDivElement>(null);
  const owner = useRef<{ binding: NativeHostBinding; page: NativePage; owned: boolean } | null>(
    null,
  );
  const language = useUiLanguage();
  const [page, setPage] = useState<NativePage | null>(null);
  const [url, setUrl] = useState(initialUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewMode, setReviewMode] = useState<'element' | 'region'>('element');
  const [reviewOptions, setReviewOptions] = useState<{ mode: 'element' | 'region'; annotation?: BrowserAnnotation }>({ mode: 'element' });
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const handledEdit = useRef<string | null>(null);
  const clearPress = () => { if (pressTimer.current !== null) window.clearTimeout(pressTimer.current); pressTimer.current = null; };
  const startReview = (mode: 'element' | 'region') => { setError(null); setReviewMode(mode); setReviewOptions({ mode }); setReviewing(true); };
  useEffect(() => () => clearPress(), []);
  useEffect(() => {
    if (!reviewEdit || !active || page?.status !== 'ready' || handledEdit.current === reviewEdit.requestId) return;
    handledEdit.current = reviewEdit.requestId;
    setError(null);
    setReviewOptions({ mode: reviewEdit.annotation.mode, annotation: reviewEdit.annotation });
    setReviewMode(reviewEdit.annotation.mode); setReviewing(true);
  }, [reviewEdit?.requestId, active, page?.status]);
  const shortAddress = () => {
    try {
      const address = new URL(url);
      return address.protocol === 'file:'
        ? (decodeURIComponent(address.pathname).split('/').at(-1) ?? url)
        : page?.kind === 'deepcode'
          ? 'DeepCode'
          : url;
    } catch {
      return url;
    }
  };
  const command = async (input: Record<string, unknown>) => {
    if (!owner.current) throw new Error('Browser page is not ready.');
    return nativeBrowserCommand<NativePage>(owner.current.binding, {
      previewId: owner.current.page.previewId,
      ...input,
    });
  };
  const updateLayout = useCallback(async () => {
    const current = owner.current;
    if (!surface.current || !current) return null;
    const rect = surface.current.getBoundingClientRect();
    const overlay = Boolean(document.querySelector(
      'dialog[open], [role="dialog"][aria-modal="true"], .deepcode-local-agent-overlay, .settings-center-overlay, details[data-native-overlay][open], [data-native-overlay]:not(details)',
    ));
    return nativeBrowserCommand<NativePage>(current.binding, {
      action: 'layout',
      previewId: current.page.previewId,
      visible: active && !overlay && rect.width > 0 && rect.height > 0,
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: rect.width,
      height: rect.height,
    });
  }, [active]);
  useEffect(() => {
    let ended = false;
    const create = async () => {
      const binding = await nativeHostBinding();
      if (!binding) throw new Error('Native browser requires the desktop GUI Host.');
      binding.sessionId = sessionId;
      const page = await nativeBrowserCommand<NativePage>(
        binding,
        initialPreviewId
          ? { action: 'status', previewId: initialPreviewId }
          : selfPreview
            ? { action: 'openSelf' }
            : {
                action: 'open',
                ...(initialPath ? { filePath: initialPath } : nativeNavigationInput(initialUrl ?? '')),
              },
      );
      if (ended) {
        if (!initialPreviewId)
          await nativeBrowserCommand(binding, { action: 'close', previewId: page.previewId });
        return;
      }
      owner.current = { binding, page, owned: !initialPreviewId };
      setPage(page);
      setUrl(page.url);
      callbacks.current.onReady(page, binding);
    };
    void create().catch((reason: unknown) => {
      if (!ended) setError(String(reason));
    });
    return () => {
      ended = true;
      const current = owner.current;
      owner.current = null;
      if (current)
        void nativeBrowserCommand(current.binding, {
          action: current.owned && !isInterfaceReloading() ? 'close' : 'layout',
          previewId: current.page.previewId,
          visible: false,
        }).catch(console.error);
    };
  }, [sessionId, initialPreviewId, initialPath, initialUrl, selfPreview]);
  useEffect(() => {
    let ended = false;
    let unlisten: (() => void) | undefined;
    void listenNativePages((next) => {
      if (ended || next.previewId !== owner.current?.page.previewId) return;
      owner.current.page = next;
      setPage(next);
      setUrl(next.url);
      if (next.status === 'closed') {
        owner.current = null;
        callbacks.current.onClose();
      } else callbacks.current.onReady(next, owner.current.binding);
    })
      .then((dispose) => {
        if (ended) dispose();
        else unlisten = dispose;
      })
      .catch((reason) => setError(String(reason)));
    return () => {
      ended = true;
      unlisten?.();
    };
  }, [sessionId]);
  useEffect(() => {
    if (!page || !surface.current) return;
    let ended = false;
    let scheduled = 0;
    const layout = () => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (ended || !surface.current || !owner.current) return;
        void updateLayout().catch((reason: unknown) => {
          if (!ended) setError(String(reason));
        });
      });
    };
    const resize = new ResizeObserver(layout);
    resize.observe(surface.current);
    const mutations = new MutationObserver(layout);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'aria-modal', 'class'],
    });
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    layout();
    return () => {
      ended = true;
      cancelAnimationFrame(scheduled);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout, true);
    };
  }, [page?.previewId, page?.status, updateLayout]);
  const act = async (action: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await command(action);
      setPage(next);
      if (next.url) setUrl(next.url);
      if (owner.current) {
        owner.current.page = next;
        callbacks.current.onReady(next, owner.current.binding);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!reviewing || !active || page?.status !== 'ready' || !owner.current) return;
    const current = owner.current;
    let ended = false, timer = 0;
    const delivered = new Set<string>();
    const reviewId = crypto.randomUUID();
    const request = <T,>(input: Record<string, unknown>) => nativeBrowserCommand<T>(current.binding, { previewId: current.page.previewId, reviewId, ...input });
    const read = async () => {
      try {
        const state = await request<{ active: boolean; exitReason: string | null; pending: BrowserAnnotation | null; mode: 'element' | 'region' }>({ action: 'reviewRead' });
        if (ended) return;
        if (!state.active) { if (state.exitReason === 'escape') setReviewing(false); return; }
        setReviewMode(state.mode);
        if (state.pending) {
          const note = state.pending;
          if (!delivered.has(note.id)) {
            const status = await request<{ captureAvailable: boolean }>({ action: 'hostStatus' });
            const screenshot = status.captureAvailable ? await request<{ contentRef: string }>({ action: 'capture' }) : null;
            if (ended) return;
            callbacks.current.onReview?.(note, current.page.previewId, screenshot?.contentRef);
            delivered.add(note.id);
          }
          await request({ action: 'reviewAcknowledge', id: note.id });
        }
        if (!ended) timer = window.setTimeout(read, 400);
      } catch (reason) {
        if (!ended) { setError(String(reason)); }
      }
    };
    const begin = async () => {
      // Reopening a draft can mount a hidden native page. Its layout must be
      // acknowledged before the review command checks visibility and geometry.
      const displayed = await updateLayout();
      if (ended) return;
      if (!displayed?.visible) throw new Error(language === 'zh-CN'
        ? '请关闭遮挡预览的窗口后再开始批注。' : 'Close the dialog covering the preview before annotating.');
      await request({ action: 'reviewStart', language, ...reviewOptions });
      if (!ended) void read();
      else void request({ action: 'reviewEnd' }).catch(console.error);
    };
    void begin()
      .catch(reason => { if (!ended) { setError(String(reason)); } });
    return () => {
      ended = true; clearTimeout(timer);
      void request({ action: 'reviewEnd' }).catch(console.error);
    };
  }, [reviewing, active, page?.previewId, page?.status, language, reviewOptions, updateLayout]);
  return (
    <section className="native-browser-preview">
      <form
        className="document-preview__toolbar native-browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          try { void act({ action: 'navigate', ...nativeNavigationInput(url) }); }
          catch (reason) { setError(String(reason)); }
        }}
      >
        <input
          aria-label={t(language, 'reader.address')}
          title={url}
          value={editingAddress ? url : shortAddress()}
          onFocus={() => setEditingAddress(true)}
          onBlur={() => setEditingAddress(false)}
          readOnly={page?.kind === 'deepcode'}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…"
        />
        <button disabled={!page || busy || page.kind === 'deepcode'} type="submit">
          {t(language, 'reader.open')}
        </button>
        <button
          disabled={!page || busy}
          type="button"
          onClick={() => void act({ action: 'reload' })}
          aria-label={t(language, 'reader.refresh')}
          title={t(language, 'reader.refresh')}
        >
          <DeepCodeShellIcon name="refresh" />
        </button>
        {reviewing ? <div className="native-browser-review-controls" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setReviewing(false); } }}>
          <button type="button" title={language === 'zh-CN' ? '点击切换；页面中长按拖动也可框选' : 'Switch selection mode; hold and drag on the page to select a region'} onClick={() => {
            const mode = reviewMode === 'element' ? 'region' : 'element';
            void command({ action: 'reviewMode', mode }).then(() => setReviewMode(mode)).catch(reason => setError(String(reason)));
          }}><DeepCodeShellIcon name="expand" /><span>{reviewMode === 'element' ? (language === 'zh-CN' ? '选取元素' : 'Element') : (language === 'zh-CN' ? '框选区域' : 'Region')}</span><DeepCodeShellIcon name="chevronDown" size={12} /></button>
          <kbd>esc</kbd><button type="button" aria-label={language === 'zh-CN' ? '退出批注' : 'Exit annotation'} onClick={() => setReviewing(false)}><DeepCodeShellIcon name="close" size={14} /></button>
        </div> : <button
          disabled={!page || page.status !== 'ready' || busy || !onReview}
          type="button"
          onPointerDown={event => { if (event.button !== 0) return; longPressed.current = false; clearPress(); pressTimer.current = window.setTimeout(() => { longPressed.current = true; startReview('region'); }, 420); }}
          onPointerUp={clearPress} onPointerCancel={clearPress} onPointerLeave={clearPress}
          onClick={() => { clearPress(); if (!longPressed.current) startReview('element'); longPressed.current = false; }}
          title={language === 'zh-CN' ? '点击选取元素，长按拖动框选区域' : 'Click to select an element; hold and drag to select a region'}
        >
          <DeepCodeShellIcon name="compose" />
          <span>{language === 'zh-CN' ? '批注' : 'Annotate'}</span>
        </button>}
      </form>
      {error && (
        <p role="alert" className="local-agent__resource-error">
          {error}
        </p>
      )}
      <div
        className="native-browser-preview__surface"
        ref={surface}
        onFocus={() =>
          void command({ action: 'focus' }).catch((reason) => setError(String(reason)))
        }
        tabIndex={0}
      />
      {!page && !error && <small role="status">{t(language, 'reader.creating')}</small>}
    </section>
  );
}
