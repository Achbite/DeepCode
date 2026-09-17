import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useSettingsStore } from '../state/settingsStore';
import { createPluginScope, errorText, UiPluginRuntime, type UiPluginEntry } from './runtime';
import { decodePluginSources, watchUiPlugins } from './source';
import type {
  UiPluginInput,
  UiPluginModule,
  UiPluginSlot,
  UiPluginView,
  UiPluginFile,
} from './types';
import './uiPlugins.css';

function insertStyle(css: string): () => void {
  const style = document.createElement('style');
  style.dataset.deepcodeUiPlugin = '';
  style.textContent = css;
  document.head.append(style);
  return () => style.remove();
}

async function importUiModule(source: string): Promise<UiPluginModule> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return (await import(/* @vite-ignore */ url)).default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface RuntimeContext {
  runtime: UiPluginRuntime;
  connectionError: string | null;
  refresh(path?: string): void;
}
const Context = createContext<RuntimeContext | null>(null);
const EMPTY: readonly UiPluginEntry[] = [];
const emptySnapshot = () => EMPTY;
const noSubscription = () => () => {};

export function UiPluginsProvider({ children }: { children: React.ReactNode }) {
  const encoded = String(
    useSettingsStore((state) => state.effectiveSettings['workbench.uiPlugins']) ?? '[]',
  );
  const runtime = useMemo(() => new UiPluginRuntime(importUiModule, insertStyle), []);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const latestFiles = useRef<UiPluginFile[]>([]);
  const refresh = useCallback(
    (path?: string) => {
      if (path)
        void runtime
          .replace(latestFiles.current, path)
          .catch((error) => setConnectionError(errorText(error)));
      else setRevision((value) => value + 1);
    },
    [runtime],
  );
  useEffect(() => {
    const controller = new AbortController();
    setConnectionError(null);
    try {
      const sources = decodePluginSources(encoded);
      void runtime.select(sources).catch((error) => setConnectionError(errorText(error)));
      if (sources.length === 0) {
        latestFiles.current = [];
        void runtime.replace([]).catch((error) => setConnectionError(errorText(error)));
      } else {
        void watchUiPlugins(sources, controller.signal, (files) => {
          latestFiles.current = files;
          void runtime.replace(files).catch((error: unknown) => {
            if (!controller.signal.aborted) setConnectionError(errorText(error));
          });
        }).catch((error: unknown) => {
          if (!controller.signal.aborted) setConnectionError(errorText(error));
        });
      }
    } catch (error) {
      setConnectionError(errorText(error));
      void runtime.dispose().catch((error) => setConnectionError(errorText(error)));
    }
    return () => controller.abort();
  }, [encoded, revision, runtime]);
  useEffect(
    () => () => {
      void runtime.dispose().catch(console.error);
    },
    [runtime],
  );
  return (
    <Context.Provider
      value={useMemo(
        () => ({ runtime, connectionError, refresh }),
        [runtime, connectionError, refresh],
      )}
    >
      {children}
    </Context.Provider>
  );
}

export function useUiPlugins() {
  const context = useContext(Context);
  const entries = useSyncExternalStore(
    context?.runtime.subscribe ?? noSubscription,
    context?.runtime.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return { entries, connectionError: context?.connectionError ?? null, refresh: context?.refresh };
}

/** Only this mount is replaced. The React owner retains the draft, scroll and conversation. */
export function UiPluginSlotView({
  slot,
  input,
  children,
}: {
  slot: Exclude<UiPluginSlot, 'theme'>;
  input: UiPluginInput;
  children: React.ReactNode;
}) {
  const context = useContext(Context);
  const { entries } = useUiPlugins();
  const entry = entries.find(
    (candidate) => candidate.status !== 'disabled' && candidate.manifest?.slots.includes(slot),
  );
  const renderer = entry?.renderers.get(slot);
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef<UiPluginView | null>(null);
  const latestInput = useRef(input);
  latestInput.current = input;
  const positions = useRef<Array<{ element: HTMLElement; top: number; left: number }>>([]);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root || !entry || !renderer || !context) return;
    const scope = createPluginScope(insertStyle, (error) => context.runtime.report(entry, error));
    const detach = context.runtime.attachView(entry, () => scope.dispose());
    try {
      const view = renderer(root, latestInput.current, scope);
      if (!view || typeof view.update !== 'function' || typeof view.dispose !== 'function')
        throw new Error('UI renderer must return update and dispose functions.');
      mounted.current = view;
      scope.onDispose(() => view.dispose());
      for (const position of positions.current) {
        position.element.scrollTop = position.top;
        position.element.scrollLeft = position.left;
      }
      positions.current = [];
    } catch (error) {
      void scope.dispose().catch(console.error).finally(detach);
      root.replaceChildren();
      context.runtime.report(entry, error);
    }
    return () => {
      positions.current = [];
      for (let element = root.parentElement; element; element = element.parentElement) {
        if (
          element.scrollHeight > element.clientHeight ||
          element.scrollWidth > element.clientWidth
        )
          positions.current.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      mounted.current = null;
      void scope
        .dispose()
        .catch((error) => context.runtime.report(entry, error))
        .finally(detach);
      root.replaceChildren();
    };
  }, [entry?.generation, renderer, context?.runtime]);

  useLayoutEffect(() => {
    if (!mounted.current || !entry || !context) return;
    try {
      mounted.current.update(input);
    } catch (error) {
      context.runtime.report(entry, error);
    }
  }, [input, entry, context?.runtime]);

  if (!entry) return <>{children}</>;
  if (entry.status === 'error')
    return (
      <div role="alert" className="ui-plugin-error">
        <strong>{entry.manifest?.name}</strong>
        <pre>{entry.error}</pre>
      </div>
    );
  if (entry.status === 'loading')
    return (
      <div className="ui-plugin-loading" role="status">
        {input.locale === 'zh-CN' ? '正在更新展示插件…' : 'Updating display plugin…'}
      </div>
    );
  return (
    <div
      className="ui-plugin-view"
      data-ui-plugin={entry.manifest?.id}
      data-ui-generation={entry.generation}
      ref={container}
    />
  );
}

export function useDisplayTheme(): string {
  return String(useSettingsStore((state) => state.effectiveSettings['gui.colorTheme']) ?? 'light');
}
