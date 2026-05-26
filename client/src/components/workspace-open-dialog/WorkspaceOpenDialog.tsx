import React, { useEffect, useMemo, useState } from 'react';
import {
  browsePath,
  getInitialLocations,
  getRuntimeType,
  pickWorkspacePath,
} from '../../services/runtimeAdapter';
import type {
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
} from '@deepcode/protocol';
import { useUiStore } from '../../state/uiStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useEditorStore } from '../../state/editorStore';
import { useSettingsStore } from '../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../i18n';
import './workspaceOpenDialog.css';

const WorkspaceOpenDialog: React.FC = () => {
  const visible = useUiStore((s) => s.workspaceOpenDialogVisible);
  const hide = useUiStore((s) => s.hideWorkspaceOpenDialog);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const closeAllFileTabs = useEditorStore((s) => s.closeAllFileTabs);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

  const [locations, setLocations] = useState<InitialLocation[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowsePathResult | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<BrowseEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    const result = await browsePath(absolutePath);
    if (result.ok && result.data) {
      setBrowseResult(result.data);
      setAddressInput(result.data.absolutePath);
    } else {
      setError(result.message ?? t(language, 'workspaceDialog.error.browse'));
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!visible) {
      setBrowseResult(null);
      setSelectedEntry(null);
      setError(null);
      setAddressInput('');
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      const init = await getInitialLocations();
      if (cancelled) return;
      if (init.ok && init.data) {
        setLocations(init.data.locations);
        const first = init.data.locations[0];
        if (first) {
          await navigateTo(first.absolutePath);
        } else {
          setLoading(false);
        }
      } else {
        setError(init.message ?? t(language, 'workspaceDialog.error.initialLocations'));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, hide]);

  const visibleEntries = useMemo<BrowseEntry[]>(() => {
    if (!browseResult) return [];
    return showHidden
      ? browseResult.entries
      : browseResult.entries.filter((entry) => !entry.hidden);
  }, [browseResult, showHidden]);

  const handleEntryDoubleClick = (entry: BrowseEntry) => {
    if (entry.type === 'directory') {
      void navigateTo(entry.absolutePath);
      return;
    }
    if (entry.isCodeWorkspace) {
      void handleOpenWorkspaceFile(entry);
    }
  };

  const handleOpenFolder = async () => {
    if (!browseResult) return;
    const targetPath =
      selectedEntry?.type === 'directory'
        ? selectedEntry.absolutePath
        : browseResult.absolutePath;

    closeAllFileTabs();
    const result = await openWorkspace(targetPath);
    if (result.ok) {
      hide();
      return;
    }
    setError(t(language, 'workspaceDialog.error.openFolder', { message: result.message ?? '' }));
  };

  const handleOpenWorkspaceFile = async (entry: BrowseEntry) => {
    if (!entry.isCodeWorkspace) return;
    closeAllFileTabs();
    const result = await openWorkspace(entry.absolutePath);
    if (result.ok) {
      hide();
      return;
    }
    setError(t(language, 'workspaceDialog.error.openWorkspaceFile', { message: result.message ?? '' }));
  };

  const handleNativeOpenFolder = async () => {
    const result = await pickWorkspacePath();
    if (!result.ok || !result.data) {
      if (result.error !== 'user_cancelled') {
        setError(result.message ?? t(language, 'workspaceDialog.error.systemPicker'));
      }
      return;
    }
    closeAllFileTabs();
    const wsResult = await openWorkspace(result.data);
    if (wsResult.ok) {
      hide();
      return;
    }
    setError(t(language, 'workspaceDialog.error.openFolder', { message: wsResult.message ?? '' }));
  };

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && addressInput.trim() !== '') {
      void navigateTo(addressInput.trim());
    }
  };

  if (!visible) return null;

  const canOpenWorkspaceFile = selectedEntry?.type === 'file' && selectedEntry.isCodeWorkspace;
  const selectedPath = selectedEntry?.absolutePath ?? browseResult?.absolutePath ?? '';
  const folderButtonLabel = selectedEntry?.type === 'directory'
    ? t(language, 'workspaceDialog.openSelectedFolder')
    : t(language, 'workspaceDialog.openCurrentFolder');

  return (
    <div className="ws-open-dialog__backdrop" onClick={hide}>
      <div
        className="ws-open-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, 'workspaceDialog.title')}
      >
        <div className="ws-open-dialog__header">
          <span>{t(language, 'workspaceDialog.title')}</span>
          <button
            className="ws-open-dialog__close"
            onClick={hide}
            title={t(language, 'window.close')}
            type="button"
          >
            x
          </button>
        </div>

        <div className="ws-open-dialog__addressbar">
          <button
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && void navigateTo(browseResult.parentPath)}
            title={t(language, 'workspaceDialog.parent')}
            type="button"
          >
            {t(language, 'workspaceDialog.up')}
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            placeholder={t(language, 'workspaceDialog.addressPlaceholder')}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={handleAddressKeyDown}
          />
          <button
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && void navigateTo(addressInput.trim())}
            type="button"
          >
            {t(language, 'workspaceDialog.go')}
          </button>
          {getRuntimeType() === 'tauri' && (
            <button
              className="ws-open-dialog__btn"
              onClick={() => void handleNativeOpenFolder()}
              title={t(language, 'workspaceDialog.systemFolderTitle')}
              type="button"
            >
              {t(language, 'workspaceDialog.systemFolder')}
            </button>
          )}
          <label className="ws-open-dialog__toggle" title={t(language, 'workspaceDialog.hiddenTitle')}>
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            <span>{t(language, 'workspaceDialog.hidden')}</span>
          </label>
        </div>

        <div className="ws-open-dialog__body">
          <aside className="ws-open-dialog__sidebar">
            <div className="ws-open-dialog__sidebar-title">
              {t(language, 'workspaceDialog.quickLocations')}
            </div>
            {locations.map((location) => (
              <button
                key={`${location.kind}::${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
                type="button"
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {location.kind === 'home' ? 'HOME' : location.kind === 'drive' ? 'DISK' : 'WS'}
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>

          <main className="ws-open-dialog__main">
            {loading && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.loading')}
              </div>
            )}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.empty')}
              </div>
            )}
            {!loading && !error && visibleEntries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {visibleEntries.map((entry) => {
                  const isSelected = selectedEntry?.absolutePath === entry.absolutePath;
                  return (
                    <li
                      key={entry.absolutePath}
                      className={
                        'ws-open-dialog__entry' +
                        (isSelected ? ' ws-open-dialog__entry--selected' : '') +
                        (entry.isCodeWorkspace ? ' ws-open-dialog__entry--code-workspace' : '')
                      }
                      onClick={() => setSelectedEntry(entry)}
                      onDoubleClick={() => handleEntryDoubleClick(entry)}
                      title={entry.absolutePath}
                    >
                      <span className="ws-open-dialog__entry-icon">
                        {entry.type === 'directory'
                          ? 'DIR'
                          : entry.isCodeWorkspace
                            ? 'WS'
                            : 'FILE'}
                      </span>
                      <span className="ws-open-dialog__entry-name">{entry.name}</span>
                      {entry.isCodeWorkspace && (
                        <span className="ws-open-dialog__entry-tag">
                          {t(language, 'workspaceDialog.workspaceTag')}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </main>
        </div>

        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info">
            {selectedPath && (
              <span>
                {t(language, 'workspaceDialog.selected')} <strong>{selectedPath}</strong>
              </span>
            )}
          </div>
          <div className="ws-open-dialog__footer-actions">
            <button className="ws-open-dialog__btn" onClick={hide} type="button">
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--secondary"
              disabled={!canOpenWorkspaceFile}
              onClick={() => selectedEntry && void handleOpenWorkspaceFile(selectedEntry)}
              title={t(language, 'workspaceDialog.openWorkspaceFileTitle')}
              type="button"
            >
              {t(language, 'workspaceDialog.openWorkspaceFile')}
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!browseResult}
              onClick={() => void handleOpenFolder()}
              title={t(language, 'workspaceDialog.openFolderTitle')}
              type="button"
            >
              {folderButtonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceOpenDialog;
