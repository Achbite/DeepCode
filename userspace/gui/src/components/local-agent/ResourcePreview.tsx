import { readDocumentText } from './documentResources';
import { UiRegion } from '../../ui-plugins/UiRegion';
import { ResourceTree } from './ResourceTree';
import { FileChangePreview } from './FileChanges';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import { restoredInterfaceView, takeRestoredInterfaceView, useInterfaceReloadView } from '../../services/interfaceReload';
import type { BrowserAnnotation, BrowserAnnotationDraft, BrowserReviewEdit } from './browserReview';
import { nextEnabledIndex } from '../shared/keyboardNavigation';
import { InterfaceLoadBoundary } from '../shared/InterfaceUpdateNotice';
import { loadInterfaceModule } from '../../services/interfaceUpdates';
import { createPortal } from 'react-dom';
import { useId, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useConversationHost } from './ConversationHost';
import type { SourcePosition } from './resourceLinks';
import { t, type UiLanguage } from '../../i18n';
import {
  readConversationArtifact,
  type ConversationResourceReadResult,
} from '../../services/localAgentApi';
import { documentFormat, type DocumentFormat } from './documentResources';
import { READER_OPEN_EVENT, readViewState, saveViewState, type ReaderTarget, readerTargetKey as targetKey } from './readerState';
import { NativeBrowserPreview } from './NativeBrowserPreview';
import {
  hasNativeBrowser,
  listenNativeActivation,
  nativeBrowserCommand,
  nativeHostBinding,
  nativeNavigationInput,
  type NativeHostBinding,
  type NativePage,
} from '../../services/nativeBrowser';
import { useSettingsStore } from '../../state/settingsStore';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import ProjectFolderDialog from '../workspace-open-dialog/ProjectFolderDialog';
import './documentPreview.css';

const DocumentPreview = lazy(() =>
  loadInterfaceModule(() => import('./DocumentPreview').then((module) => ({ default: module.DocumentPreview }))),
);
const SourceFileView = lazy(() => loadInterfaceModule(() => import('./SourceFileView')));
type ResolvedReaderTarget = Exclude<ReaderTarget, { kind: 'browser' }>
  | (Extract<ReaderTarget, { kind: 'browser' }> & { previewId: string });
type ReaderTab = { id: string; target: ResolvedReaderTarget; page?: NativePage };
type DocumentState =
  | { status: 'loading' }
  | { status: 'document'; blob: Blob; format: DocumentFormat | 'image' }
  | { status: 'source'; content: string }
  | { status: 'text'; result: ConversationResourceReadResult }
  | { status: 'error'; error: string };
export function readerFilename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .at(-1) || path
  );
}
export function readerPageName(url: string): string {
  try {
    const value = new URL(url);
    return value.protocol === 'file:'
      ? readerFilename(decodeURIComponent(value.pathname))
      : value.host || url;
  } catch {
    return url;
  }
}
function tabName(tab: ReaderTab, language: UiLanguage): string {
  if (tab.page) return readerPageName(tab.page.url);
  if (tab.target.kind === 'diff') return readerFilename(tab.target.file.path) + ' · diff';
  if (tab.target.kind === 'resource') return tab.target.name;
  if (tab.target.kind === 'file') return readerFilename(tab.target.path);
  if (tab.target.kind === 'workspace') return readerFilename(tab.target.logicalPath);
  if (tab.target.kind === 'artifact') return readerFilename(tab.target.artifact.label);
  return tab.target.selfPreview
    ? 'DeepCode'
    : tab.target.filePath
      ? readerFilename(tab.target.filePath)
      : tab.target.url
        ? readerPageName(tab.target.url)
        : language === 'zh-CN' ? '浏览器' : 'Browser';
}

/** View state owns open tabs; a collapsed panel keeps their content and native pages mounted. */
export function useResourcePreview(sessionId: string | null) {
  const host = useConversationHost();
  const [state, setState] = useState<{
    sessionId: string | null;
    tabs: ReaderTab[];
    activeId: string | null;
    visible: boolean;
    expanded: boolean;
  }>({ sessionId, tabs: [], activeId: null, visible: false, expanded: false });
  useInterfaceReloadView('reader', { ...state, tabs: state.tabs.map(tab => tab.page ? { ...tab, target: { kind: 'browser', previewId: tab.page.previewId } } : tab) });
  const [treeVisible, setTreeVisible] = useState(() => readViewState('file-tree', true));
  const [width, setWidth] = useState(() => readViewState('panel-width', 55));
  const [error, setError] = useState<string | null>(null);
  const [reviewEdit, setReviewEdit] = useState<(BrowserReviewEdit & { sessionId: string | null }) | null>(null);
  const bindings = useRef(new Map<string, NativeHostBinding>());
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const live =
    state.sessionId === sessionId
      ? state
      : { sessionId, tabs: [], activeId: null, visible: false, expanded: false };
  const selectTarget = useCallback(
    (target: ResolvedReaderTarget) => {
      if (!sessionId) return;
      const key = targetKey(target);
      setState((old) => {
        const tabs = old.sessionId === sessionId ? old.tabs : [];
        const existing = tabs.find(
          (tab) =>
            tab.id === key ||
            (target.kind === 'browser' &&
              target.previewId &&
              tab.page?.previewId === target.previewId),
        );
        return {
          sessionId,
          tabs: existing ? tabs.map((tab) => tab === existing && target.kind === 'workspace' ? { ...tab, target } : tab) : [...tabs, { id: key, target }],
          activeId: existing?.id ?? key,
          visible: true,
          expanded: old.sessionId === sessionId && old.expanded,
        };
      });
      saveViewState(sessionId + ':selection', target);
      setError(null);
    },
    [sessionId],
  );
  const openTarget = useCallback((target: ReaderTarget) => {
    if (!sessionId) return;
    if (target.kind !== 'browser') {
      selectTarget(target);
      return;
    }
    if (target.previewId) {
      selectTarget({ ...target, previewId: target.previewId });
      return;
    }
    const open = async () => {
      const binding = await nativeHostBinding();
      if (!binding) throw new Error('Native browser requires the desktop GUI Host.');
      const page = await nativeBrowserCommand<NativePage>({ ...binding, sessionId }, target.selfPreview
        ? { action: 'openSelf' }
        : { action: 'open', ...(target.filePath ? { filePath: target.filePath } : nativeNavigationInput(target.url ?? '')) });
      if (currentSession.current === sessionId) selectTarget({ kind: 'browser', previewId: page.previewId });
    };
    void open().catch((reason) => { if (currentSession.current === sessionId) setError(String(reason)); });
  }, [sessionId, selectTarget]);
  useEffect(() => {
    bindings.current.clear();
    setState(current => current.sessionId === sessionId ? current : { sessionId, tabs: [], activeId: null, visible: false, expanded: false });
    setError(null);
    if (!sessionId) return;
    const saved = readViewState<ReaderTarget | null>(sessionId + ':selection', null);
    const restored = restoredInterfaceView<typeof state | null>('reader', null);
    if (restored?.sessionId === sessionId) takeRestoredInterfaceView('reader', null);
    if (restored?.sessionId === sessionId) setState(restored);
    else if (saved && saved.kind !== 'browser') openTarget(saved);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; target: ReaderTarget }>).detail;
      if (detail.sessionId === sessionId) openTarget(detail.target);
    };
    window.addEventListener(READER_OPEN_EVENT, listener);
    return () => window.removeEventListener(READER_OPEN_EVENT, listener);
  }, [sessionId, openTarget]);
  const activationTarget = useRef(openTarget); activationTarget.current = openTarget;
  useEffect(() => {
    if (!hasNativeBrowser()) return;
    let ended = false;
    let unlisten: (() => void) | undefined;
    void listenNativeActivation(page => {
      if (ended) return;
      if (page.sessionId !== currentSession.current) {
        void nativeBrowserCommand(page, { action: 'activationResult', previewId: page.previewId,
          activationId: page.surface.activationId, reason: 'sessionNotSelected' }).catch(reason => setError(String(reason)));
        return;
      }
      activationTarget.current({ kind: 'browser', previewId: page.previewId });
      window.dispatchEvent(new CustomEvent('deepcode:browser-layout', { detail: page }));
    }).then(dispose => { if (ended) dispose(); else unlisten = dispose; })
      .catch(reason => { if (!ended) setError(String(reason)); });
    return () => { ended = true; unlisten?.(); };
  }, []);
  const openWorkspaceResource = async (workspaceId: string, logicalPath: string, position?: SourcePosition) => {
    if (!sessionId) return;
    const resource = await host.resolveResource(sessionId, workspaceId, logicalPath);
    if (currentSession.current !== sessionId) return;
    if (resource.kind === 'directory') {
      if (!host.locatePath) throw new Error('Directory opening requires the desktop Host.');
      await host.locatePath(resource.path);
      return;
    }
    if (
      useSettingsStore.getState().effectiveSettings['gui.defaultFileOpen'] === 'vscode' &&
      !/\.(pdf|png|jpe?g|gif|webp|svg|bmp)$/i.test(logicalPath)
    ) {
      if (!host.openFile) throw new Error('Open in VS Code is unavailable in this Host.');
      await host.openFile(resource.path, position);
      return;
    }
    openTarget({ kind: 'workspace', workspaceId, logicalPath, line: position?.line, column: position?.column });
  };
  const removeTab = (id: string) => {
    bindings.current.delete(id);
    setState((old) => {
      const tabs = old.tabs.filter((tab) => tab.id !== id);
      const activeId = old.activeId === id ? (tabs.at(-1)?.id ?? null) : old.activeId;
      saveViewState(
        sessionId + ':selection',
        tabs.find((tab) => tab.id === activeId)?.target ?? null,
      );
      return { ...old, tabs, activeId };
    });
  };
  const closeTab = async (id: string) => {
    if (!sessionId) return;
    const tab = live.tabs.find((tab) => tab.id === id);
    try {
      if (tab?.target.kind === 'browser') {
        const binding = bindings.current.get(id) ?? await nativeHostBinding();
        if (!binding) throw new Error('Native browser requires the desktop GUI Host.');
        await nativeBrowserCommand({ ...binding, sessionId }, { action: 'close', previewId: tab.target.previewId });
      }
      if (currentSession.current === sessionId) removeTab(id);
    } catch (reason) {
      if (currentSession.current === sessionId) setError(String(reason));
    }
  };
  const ready = (id: string, page: NativePage, binding: NativeHostBinding) => {
    bindings.current.set(id, binding);
    setState((old) => ({
      ...old,
      tabs: old.tabs.map((tab) => (tab.id === id ? { ...tab, page } : tab)),
    }));
  };
  const resize = (value: number) => {
    const next = Math.min(75, Math.max(30, value));
    setWidth(next);
    saveViewState('panel-width', next);
  };
  const toggle = () =>
    setState((old) => ({ ...old, sessionId, visible: !old.visible, expanded: false }));
  const expand = () => setState((old) => ({ ...old, expanded: !old.expanded }));
  const selectTab = (id: string) =>
    setState((old) => {
      saveViewState(
        sessionId + ':selection',
        old.tabs.find((tab) => tab.id === id)?.target ?? null,
      );
      return { ...old, activeId: id };
    });
  const newPage = () => setState((old) => ({ ...old, activeId: null, visible: true }));
  return {
    ...live,
    width,
    treeVisible,
    toggleTree() { setTreeVisible(value => { saveViewState('file-tree', !value); return !value; }); },
    error,
    openTarget,
    openWorkspaceResource,
    closeTab,
    removeTab,
    ready,
    resize,
    toggle,
    expand,
    selectTab,
    newPage,
    reviewEdit: reviewEdit?.sessionId === sessionId ? reviewEdit : null,
    editBrowserReview(review: BrowserAnnotationDraft) {
      openTarget({ kind: 'browser', previewId: review.previewId, url: review.annotation.url });
      setReviewEdit({ requestId: crypto.randomUUID(), sessionId, previewId: review.previewId, annotation: review.annotation });
    },
  };
}

export function ResourcePreview({
  language,
  preview,
  tabsTarget,
  onReview,
}: {
  language: UiLanguage;
  preview: ReturnType<typeof useResourcePreview>;
  tabsTarget?: HTMLElement | null;
  onReview?: (annotation: BrowserAnnotation, previewId: string, screenshot?: string) => void;
}) {
  const chinese = language === 'zh-CN';
  const readerData = { kind: 'reader' as const, tabs: preview.tabs.map(tab => ({ id: tab.id, title: tabName(tab, language) })),
    activeId: preview.activeId, visible: preview.visible, expanded: preview.expanded, treeVisible: preview.treeVisible };
  const readerActions = { toggleTree: preview.toggleTree, toggleReaderExpanded: preview.expand,
    selectReaderTab: (id: string) => { if (preview.tabs.some(tab => tab.id === id)) preview.selectTab(id); } };
  const tabsId = useId();
  const resizeHandle = useRef<HTMLDivElement | null>(null);
  const resizePointer = useRef<number | null>(null);
  const endResize = useCallback(() => {
    const pointer = resizePointer.current;
    resizePointer.current = null;
    if (pointer !== null && resizeHandle.current?.hasPointerCapture(pointer)) resizeHandle.current.releasePointerCapture(pointer);
    document.body.classList.remove('reader-resizing');
  }, []);
  useEffect(() => {
    window.addEventListener('blur', endResize);
    return () => { window.removeEventListener('blur', endResize); endResize(); };
  }, [endResize]);
  useEffect(() => { if (!preview.visible || preview.expanded) endResize(); }, [preview.visible, preview.expanded, endResize]);
  const tabs = (
        <header className="reader-tabs">
          <div
            className="reader-tabs__list"
            role="tablist"
            aria-label={chinese ? '打开的预览' : 'Open previews'}
          >
            {preview.tabs.map((tab, index) => (
              <div
                className={
                  'reader-tab' + (tab.id === preview.activeId ? ' reader-tab--active' : '')
                }
                key={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  id={`${tabsId}-tab-${index}`}
                  aria-controls={`${tabsId}-panel-${index}`}
                  tabIndex={tab.id === preview.activeId || (!preview.activeId && index === 0) ? 0 : -1}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = nextEnabledIndex(preview.tabs.map(() => true), index, event.key);
                    preview.selectTab(preview.tabs[next].id);
                    document.getElementById(`${tabsId}-tab-${next}`)?.focus();
                  }}
                  aria-selected={tab.id === preview.activeId}
                  onClick={() => preview.selectTab(tab.id)}
                  title={tabName(tab, language)}
                >
                  <DeepCodeShellIcon name="artifact" />
                  <span>{tab.target.kind === 'diff' ? readerFilename(tab.target.file.path) : tabName(tab, language)}</span>
                  {tab.target.kind === 'diff' && <small className="reader-tab__kind">· diff</small>}
                </button>
                <button
                  type="button"
                  onClick={() => void preview.closeTab(tab.id)}
                  aria-label={(chinese ? '关闭 ' : 'Close ') + tabName(tab, language)}
                >
                  <DeepCodeShellIcon name="close" />
                </button>
              </div>
            ))}
          </div>
          <button
            className="reader-icon-button"
            type="button"
            onClick={preview.newPage}
            aria-label={chinese ? '打开预览' : 'Open preview'}
            title={chinese ? '打开预览' : 'Open preview'}
          >
            <DeepCodeShellIcon name="plus" />
          </button>
        </header>
  );
  return (
    <>
      {preview.visible && (
        <div
          className="reader-resize"
          ref={resizeHandle}
          role="separator"
          tabIndex={0}
          aria-label={chinese ? '调整预览宽度' : 'Resize preview'}
          aria-orientation="vertical"
          aria-valuemin={30}
          aria-valuemax={75}
          aria-valuenow={Math.round(preview.width)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            document.getSelection()?.removeAllRanges();
            document.body.classList.add('reader-resizing');
            resizePointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            endResize();
          }}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = event.currentTarget.parentElement!.getBoundingClientRect();
            preview.resize(((rect.right - event.clientX) / rect.width) * 100);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              preview.resize(preview.width + (event.key === 'ArrowLeft' ? 3 : -3));
            }
          }}
        />
      )}
      <aside
        className="local-agent__reader"
        hidden={!preview.visible}
        aria-label={t(language, 'agent.resource.preview')}
      >
        {tabsTarget ? createPortal(tabs, tabsTarget) : tabs}
        {preview.error && (
          <p role="alert" className="local-agent__resource-error">
            {preview.error}
          </p>
        )}
        <UiRegion slot="reader.toolbar" data={readerData} actions={readerActions}><ReaderFileHeader sessionId={preview.sessionId} target={preview.tabs.find(tab => tab.id === preview.activeId)?.target} language={language} treeVisible={preview.treeVisible} /></UiRegion>
        <div className="reader-workspace"><UiRegion slot="reader.layout" data={readerData} actions={readerActions}>
        <div className="reader-panes">
          {preview.tabs.map((tab, index) => (
            <div
              className="reader-pane"
              key={preview.sessionId + ':' + tab.id}
              hidden={preview.activeId !== tab.id}
              role="tabpanel" id={`${tabsId}-panel-${index}`} aria-labelledby={`${tabsId}-tab-${index}`}
            >
              {tab.target.kind === 'browser' && preview.sessionId ? (
                <NativeBrowserPreview
                  sessionId={preview.sessionId}
                  active={preview.visible && preview.activeId === tab.id}
                  onReady={(page, binding) => preview.ready(tab.id, page, binding)}
                  onClose={() => preview.removeTab(tab.id)}
                  previewId={tab.target.previewId}
                  onReview={onReview}
                  reviewEdit={preview.reviewEdit?.previewId === (tab.page?.previewId ?? tab.target.previewId) ? preview.reviewEdit : null}
                />
              ) : tab.target.kind === 'diff' && preview.sessionId ? (
                <FileChangePreview sessionId={preview.sessionId} file={tab.target.file} />
              ) : (
                preview.sessionId && (
                  <ReaderDocument
                    key={tab.target.kind === 'workspace' ? `${tab.id}:${tab.target.line ?? ''}:${tab.target.column ?? ''}` : tab.id}
                    sessionId={preview.sessionId}
                    target={tab.target as Exclude<ReaderTarget, { kind: 'browser' | 'diff' }>}
                    active={preview.visible && preview.activeId === tab.id}
                    language={language}
                    openTarget={preview.openTarget}
                  />
                )
              )}
            </div>
          ))}
          {preview.activeId === null && preview.sessionId && (
            <ReaderStart
              sessionId={preview.sessionId}
              language={language}
              openTarget={preview.openTarget}
            />
          )}
        </div>
        {preview.sessionId && <UiRegion slot="reader.tree" data={readerData} actions={readerActions}><ResourceTree key={preview.sessionId} sessionId={preview.sessionId} visible={preview.visible && preview.treeVisible} activeTarget={preview.tabs.find(tab => tab.id === preview.activeId)?.target} language={language} openTarget={preview.openTarget} /></UiRegion>}
        </UiRegion></div>
      </aside>
    </>
  );
}

/** Shared header controls stay mounted at the same position in split and expanded views. */
export function ReaderControls({ language, preview, disabled }: {
  language: UiLanguage;
  preview: ReturnType<typeof useResourcePreview>;
  disabled: boolean;
}) {
  const chinese = language === 'zh-CN';
  const expandLabel = preview.expanded ? (chinese ? '返回并排' : 'Restore split view') : (chinese ? '铺满工作区' : 'Expand preview');
  const sidebarLabel = chinese ? '浏览器与预览' : 'Browser and preview';
  return <>
    {preview.visible && <button type="button" className="reader-icon-button" aria-label={chinese ? '文件树' : 'File tree'} title={chinese ? '文件树' : 'File tree'} aria-pressed={preview.treeVisible} onClick={preview.toggleTree}><DeepCodeShellIcon name="folder" /></button>}
    {preview.visible && <button type="button" className="reader-icon-button" onClick={preview.expand} aria-label={expandLabel} title={expandLabel}>
      <DeepCodeShellIcon name={preview.expanded ? 'collapse' : 'expand'} />
    </button>}
    <button type="button" className="reader-icon-button" disabled={disabled} aria-label={sidebarLabel} title={sidebarLabel} aria-pressed={preview.visible} onClick={preview.toggle}>
      <DeepCodeShellIcon name="sidebar" />
    </button>
  </>;
}

function ReaderStart({
  sessionId,
  language,
  openTarget,
}: {
  sessionId: string;
  language: UiLanguage;
  openTarget(target: ReaderTarget): void;
}) {
  const addressId = useId();
  const browserButton = useRef<HTMLButtonElement>(null);
  const [enteringAddress, setEnteringAddress] = useState(false);
  const [url, setUrl] = useState(''),
    [pages, setPages] = useState<NativePage[]>([]),
    [error, setError] = useState<string | null>(null),
    [choosing, setChoosing] = useState<'file' | 'browser' | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const binding = await nativeHostBinding();
      if (!binding) return;
      const result = await nativeBrowserCommand<{ pages: NativePage[] }>(
        { ...binding, sessionId },
        { action: 'list' },
      );
      if (active) setPages(result.pages.filter((page) => page.status !== 'closed' && page.kind !== 'deepcode'));
    })().catch((reason) => {
      if (active) setError(String(reason));
    });
    return () => {
      active = false;
    };
  }, [sessionId]);
  return (
    <div className="reader-start">
      {hasNativeBrowser() ? (
        <>
          <div className="reader-start__entries">
            <button type="button" className="reader-start__entry" onClick={() => setChoosing('file')}>
              <DeepCodeShellIcon name="folder" />
              <span>{language === 'zh-CN' ? '打开文件' : 'Open file'}</span>
              <DeepCodeShellIcon name="chevronRight" />
            </button>
            <button
              ref={browserButton}
              type="button"
              className="reader-start__entry"
              aria-expanded={enteringAddress}
              aria-controls={addressId}
              onClick={() => setEnteringAddress((value) => !value)}
            >
              <DeepCodeShellIcon name="browser" />
              <span>{t(language, 'reader.start.browser')}</span>
              <DeepCodeShellIcon name={enteringAddress ? 'chevronDown' : 'chevronRight'} />
            </button>
          </div>
          {enteringAddress && <button type="button" className="settings-button" onClick={() => setChoosing('browser')}>
            {language === 'zh-CN' ? '在浏览器中打开本地 HTML' : 'Open local HTML in browser'}
          </button>}
          {enteringAddress && (
            <form
              id={addressId}
              onSubmit={(event) => {
                event.preventDefault();
                if (url.trim()) openTarget({ kind: 'browser', url: url.trim() });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setEnteringAddress(false);
                  browserButton.current?.focus();
                }
              }}
            >
              <input
                autoFocus
                aria-label={t(language, 'reader.address')}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
              />
              <button className="settings-button" disabled={!url.trim()}>
                {t(language, 'reader.open')}
              </button>
            </form>
          )}
          {pages.length > 0 && (
            <section className="reader-start__pages">
              <h3>{t(language, 'reader.start.openPages')}</h3>
              {pages.map((page) => (
                <button
                  type="button"
                  className="reader-start__entry"
                  key={page.previewId}
                  title={page.url}
                  onClick={() => openTarget({ kind: 'browser', previewId: page.previewId })}
                >
                  <DeepCodeShellIcon name="browser" />
                  <span>{readerPageName(page.url)}</span>
                  <DeepCodeShellIcon name="chevronRight" />
                </button>
              ))}
            </section>
          )}
        </>
      ) : (
        <p>
          {language === 'zh-CN' ? '文件按原始内容阅读；网页和本地 HTML 可在浏览器中运行。' : 'Read original file contents, or run a web page or local HTML in the browser.'}
        </p>
      )}
      {error && (
        <p role="alert" className="local-agent__resource-error">
          {error}
        </p>
      )}
      {choosing && (
        <ProjectFolderDialog
          language={language}
          selectionMode="file"
          filters={choosing === 'browser' ? [{ name: 'HTML', extensions: ['html', 'htm'] }] : undefined}
          title={language === 'zh-CN' ? (choosing === 'browser' ? '选择要运行的 HTML' : '打开文件') : 'Open file'}
          onCancel={() => setChoosing(null)}
          onSelect={(path, kind) => {
            if (kind !== 'file') { setError(language === 'zh-CN' ? '请选择文件。' : 'Select a file.'); setChoosing(null); return; }
            setChoosing(null);
            openTarget(choosing === 'browser' ? { kind: 'browser', filePath: path } : { kind: 'file', path });
          }}
        />
      )}
    </div>
  );
}

function ReaderDocument({
  active,
  sessionId,
  target,
  language,
  openTarget,
}: {
  sessionId: string;
  active: boolean;
  target: Exclude<ReaderTarget, { kind: 'browser' | 'diff' }>;
  language: UiLanguage;
  openTarget(target: ReaderTarget): void;
}) {
  const host = useConversationHost(),
    chinese = language === 'zh-CN';
  const [state, setState] = useState<DocumentState>({ status: 'loading' }),
    [revision, setRevision] = useState(0),
    [startByte, setStartByte] = useState<number>();
  const [location, setLocation] = useState<string | null>(null),
    [locationError, setLocationError] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const path = target.kind === 'resource' ? (target.resource.logicalPath || target.name) : target.kind === 'workspace' ? target.logicalPath : target.kind === 'file' ? target.path : target.artifact.label,
    key = sessionId + ':' + targetKey(target) + (target.kind === 'workspace' && target.line ? `:${target.line}:${target.column ?? 1}` : '');
  const sourceLine = target.kind === 'workspace' ? target.line : undefined;
  const sourceColumn = target.kind === 'workspace' ? target.column : undefined;
  const [wrap, setWrap] = useState(() => readViewState(key + ':wrap', true));
  useEffect(() => setWrap(readViewState(key + ':wrap', true)), [key]);
  const columnOffset = state.status === 'text' && sourceLine && sourceColumn && startByte === undefined
    ? Math.min(sourceColumn - 1, state.result.content.split('\n', 1)[0].length)
    : undefined;
  useEffect(() => { setStartByte(undefined); }, [target]);
  const reference = targetResource(target);
  const referenceId = reference && resourceKey(reference);
  const [watchError, setWatchError] = useState('');
  useEffect(() => {
    if (!active || !reference) return;
    const controller = new AbortController();
    setWatchError('');
    void host.resources.watchResources(sessionId, [reference], controller.signal, () => setRevision(value => value + 1))
      .catch(error => { if (!controller.signal.aborted) setWatchError(String(error)); });
    return () => controller.abort();
  }, [sessionId, active, referenceId, host]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      if (target.kind === 'file') {
        if (!host.readLocalFile) throw new Error('Local file reading requires the desktop Host.');
        const blob = await host.readLocalFile(target.path);
        if (documentFormat(path)) {
          const header = await blob.slice(0, 5).text();
          if (documentFormat(path) === 'pdf' && header !== '%PDF-') throw new Error('当前文件不是 PDF 文档。');
          if (!controller.signal.aborted) setState({ status: 'document', blob, format: documentFormat(path)! });
        } else {
          const content = await readDocumentText(blob);
          if (!controller.signal.aborted) setState({ status: 'source', content });
        }
        return;
      }
      if (target.kind === 'artifact') {
        const a = target.artifact,
          blob = await readConversationArtifact(sessionId, a.artifactId, controller.signal);
        const format = a.contentType.startsWith('image/')
          ? 'image'
          : a.contentType === 'text/html'
            ? 'html'
            : a.contentType === 'application/pdf'
              ? 'pdf'
              : a.contentType === 'text/markdown'
                ? 'markdown'
                : null;
        if (!format && (a.contentType.startsWith('text/') || a.contentType === 'application/json')) {
          const content = await readDocumentText(blob);
          if (!controller.signal.aborted) setState({ status: 'source', content });
          return;
        }
        if (!format) throw new Error('Unsupported artifact media type: ' + a.contentType);
        if (!controller.signal.aborted) setState({ status: 'document', blob, format });
        return;
      }
      const format = startByte === undefined && sourceLine === undefined ? documentFormat(path) : null;
      if (startByte === undefined && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) {
        const blob = await host.resources.readResourceBlob(sessionId, reference!, 'image', controller.signal);
        if (!controller.signal.aborted) setState({ status: 'document', blob, format: 'image' });
      } else if (format) {
        const blob = await host.resources.readResourceBlob(sessionId, reference!, 'document', controller.signal);
        if (!controller.signal.aborted) setState({ status: 'document', blob, format });
      } else {
        const result = await host.resources.readResourceReference(sessionId, reference!, controller.signal, startByte, sourceLine);
        if (!controller.signal.aborted) setState({ status: 'text', result });
      }
    })().catch((reason) => {
      if (!controller.signal.aborted) setState({ status: 'error', error: String(reason) });
    });
    return () => controller.abort();
  }, [sessionId, target, host, path, startByte, sourceLine, revision, active]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = sourceLine ? 0 : readViewState(key + ':scroll', 0);
  }, [key, state.status, sourceLine]);
  const resolve = async () => {
    if (target.kind === 'file') return target.path;
    if (target.kind === 'artifact') return target.artifact.logicalPath ?? target.artifact.uri ?? target.artifact.artifactId;
    return (await host.resources.resolveResourceReference(sessionId, reference!)).path;
  };
  const actions = <>
        {(state.status === 'source' || state.status === 'text') && <button
          className="reader-wrap-button" type="button" aria-pressed={wrap}
          onClick={() => { const next = !wrap; setWrap(next); saveViewState(key + ':wrap', next); }}
          title={chinese ? '按面板宽度折行，保留原文与行号' : 'Wrap to panel width without changing the source'}
        >{chinese ? '自动换行' : 'Word wrap'}</button>}
        <details
          className="reader-location"
          data-native-overlay
          onToggle={(event) => {
            if (event.currentTarget.open) {
              setLocationError(null);
              void resolve()
                .then(setLocation)
                .catch((reason) => setLocationError(String(reason)));
            }
          }}
        >
          <summary className="reader-icon-button" aria-label={chinese ? '文件位置' : 'File location'} title={chinese ? '文件位置' : 'File location'}><DeepCodeShellIcon name="info" /></summary>
          <div className="reader-location-detail">
            <code>{locationError ?? location ?? (chinese ? '正在读取…' : 'Loading…')}</code>
            {location && !locationError && (
              <button
                type="button"
                className="settings-button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(location)
                    .catch((reason) => setLocationError(String(reason)))
                }
              >
                {chinese ? '复制位置' : 'Copy location'}
              </button>
            )}
          </div>
        </details>
        {target.kind !== 'artifact' && hasNativeBrowser() && /\.html?$/i.test(path) && (
          <button
            className="settings-button"
            onClick={() =>
              void resolve()
                .then((filePath) => openTarget({ kind: 'browser', filePath }))
                .catch((reason) => setLocationError(String(reason)))
            }
          >
            {chinese ? '在浏览器中打开' : 'Open in browser'}
          </button>
        )}
        <button
          className="reader-icon-button"
          disabled={state.status === 'loading'}
          onClick={() => setRevision((value) => value + 1)}
          aria-label={chinese ? '重新读取' : 'Reload'}
          title={chinese ? '重新读取' : 'Reload'}
        >
          <DeepCodeShellIcon name="refresh" />
        </button>
    </>;
  return (
    <>
      {state.status !== 'document' && <div className="document-preview__toolbar document-preview__file-toolbar">
        <div className="document-preview__actions">{actions}</div>
      </div>}
      {state.status !== 'error' && watchError && <p role="alert" className="local-agent__resource-error">{watchError}</p>}
      {locationError && (
        <p role="alert" className="local-agent__resource-error">
          {locationError}
        </p>
      )}
      <div
        ref={scroll}
        className={`local-agent__resource-body${state.status === 'source' || state.status === 'text' ? ' reader-source-body' : ''}`}
        onScroll={() => {
          if (scroll.current) saveViewState(key + ':scroll', scroll.current.scrollTop);
        }}
      >
        {state.status === 'loading' ? (
          <p>{t(language, 'agent.resource.reading')}</p>
        ) : state.status === 'error' ? (
          <p role="alert" className="local-agent__resource-error">
            {state.error}
          </p>
        ) : state.status === 'source' ? (
          <InterfaceLoadBoundary><Suspense fallback={<p>{t(language, 'agent.resource.reading')}</p>}>
            <SourceFileView viewKey={key} content={state.content} filename={path} wrap={wrap} />
          </Suspense></InterfaceLoadBoundary>
        ) : state.status === 'document' ? (
          <InterfaceLoadBoundary><Suspense fallback={<p>{t(language, 'agent.resource.reading')}</p>}>
            <DocumentPreview
              readingKey={key}
              blob={state.blob}
              format={state.format}
              filename={path}
              language={language}
              actions={actions}
            />
          </Suspense></InterfaceLoadBoundary>
        ) : (
          <>
            {sourceLine && <small>{chinese ? '起始行' : 'Starting line'} {state.result.startLine}{target.kind === 'workspace' && target.column ? ` · ${chinese ? '列' : 'column'} ${target.column}` : ''}</small>}
            <InterfaceLoadBoundary><Suspense fallback={<p>{t(language, 'agent.resource.reading')}</p>}>
              <SourceFileView viewKey={key} content={state.result.content} filename={path} startLine={state.result.startLine} column={columnOffset === undefined ? 1 : columnOffset + 1} wrap={wrap} />
            </Suspense></InterfaceLoadBoundary>
            {state.result.truncated && (
              <small>{chinese ? '当前为部分内容。' : 'Partial content.'}</small>
            )}
            {state.result.nextByte !== undefined && (
              <button
                className="settings-button"
                onClick={() => setStartByte(state.result.nextByte)}
              >
                {chinese ? '读取下一段' : 'Read next section'}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function targetResource(target: ReaderTarget): ResourceReference | undefined {
  if (target.kind === 'resource') return target.resource;
  if (target.kind === 'workspace') return { workspaceId: target.workspaceId, logicalPath: target.logicalPath };
  if (target.kind === 'diff') {
    const { recordId, index } = target.file.changes.at(-1)!;
    return { change: { recordId, index }, logicalPath: '' };
  }
}

function ReaderFileHeader({ sessionId, target, language, treeVisible }: {
  sessionId: string | null; target?: ReaderTarget; language: UiLanguage; treeVisible: boolean;
}) {
  const host = useConversationHost();
  const [error, setError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const name = !target || target.kind === 'browser' ? '' : target.kind === 'diff' ? readerFilename(target.file.path)
    : target.kind === 'resource' ? target.name : target.kind === 'workspace' ? readerFilename(target.logicalPath)
    : target.kind === 'file' ? readerFilename(target.path) : target.artifact.label;
  const open = async (action: 'code' | 'folder') => {
    if (!sessionId || !target) return;
    if (menu.current) menu.current.open = false;
    setError('');
    try {
      const reference = targetResource(target);
      const path = target.kind === 'file' ? target.path : reference ? (await host.resources.resolveResourceReference(sessionId, reference)).path : undefined;
      if (!path) throw new Error('resource_has_no_local_file');
      if (action === 'code') await host.openFile?.(path);
      else await host.locatePath?.(path);
    } catch (error) { setError(String(error)); }
  };
  useEffect(() => setError(''), [target]);
  return <>
    <div className="reader-file-header">
      <strong title={name}>{name}</strong>
      {treeVisible && <span className="reader-file-header__tree-title">{language === 'zh-CN' ? '文件' : 'Files'}</span>}
      <details className="reader-external-open" ref={menu} data-native-overlay onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
      }}>
        <summary>{language === 'zh-CN' ? '打开' : 'Open'} <DeepCodeShellIcon name="chevronDown" /></summary>
        <div role="menu">
          <button role="menuitem" disabled={!target || target.kind === 'browser' || target.kind === 'artifact'} onClick={() => void open('code')}>{language === 'zh-CN' ? '在 VS Code 中打开' : 'Open in VS Code'}</button>
          <button role="menuitem" disabled={!target || target.kind === 'browser' || target.kind === 'artifact'} onClick={() => void open('folder')}>{language === 'zh-CN' ? '打开所在文件夹' : 'Show in folder'}</button>
        </div>
      </details>
    </div>
    {error && <p role="alert" className="local-agent__resource-error">{error}</p>}
  </>;
}
