import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import React, { useEffect, useRef, useState } from 'react';
import {
  nativeBrowserCommand,
  nativeHostBinding,
  listenNativePages,
  nativeNavigationInput,
  type NativeHostBinding,
  type NativePage,
} from '../../services/nativeBrowser';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

export function NativeBrowserPreview({
  sessionId,
  active,
  onClose,
  onReady,
  initialUrl,
  initialPath,
  initialPreviewId,
  selfPreview,
}: {
  sessionId: string;
  active: boolean;
  onClose(): void;
  onReady(page: NativePage, binding: NativeHostBinding): void;
  initialUrl?: string;
  initialPath?: string;
  initialPreviewId?: string;
  selfPreview?: boolean;
}) {
  const callbacks = useRef({ onClose, onReady });
  callbacks.current = { onClose, onReady };
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
          action: current.owned ? 'close' : 'layout',
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
        const rect = surface.current.getBoundingClientRect();
        const overlay = Boolean(
          document.querySelector(
            'dialog[open], [role="dialog"][aria-modal="true"], .deepcode-local-agent-overlay, .settings-center-overlay, details[data-native-overlay][open], [data-native-overlay]:not(details)',
          ),
        );
        void command({
          action: 'layout',
          visible: active && !overlay && rect.width > 0 && rect.height > 0,
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: rect.width,
          height: rect.height,
        }).catch((reason: unknown) => {
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
  }, [page?.previewId, active]);
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
