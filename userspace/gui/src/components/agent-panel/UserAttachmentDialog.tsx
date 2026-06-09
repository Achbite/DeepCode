import React, { useEffect, useMemo, useState } from 'react';
import type {
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
} from '@deepcode/protocol';
import {
  browsePath,
  getInitialLocations,
} from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
import '../workspace-open-dialog/workspaceOpenDialog.css';

export interface PickedUserAttachment {
  kind: 'file' | 'directory';
  absolutePath: string;
}

interface UserAttachmentDialogProps {
  visible: boolean;
  initialDirectory?: string | null;
  language: UiLanguage;
  onClose: () => void;
  onPick: (attachment: PickedUserAttachment) => void;
}

const UserAttachmentDialog: React.FC<UserAttachmentDialogProps> = ({
  visible,
  initialDirectory,
  language,
  onClose,
  onPick,
}) => {
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
        const startPath = initialDirectory?.trim() || first?.absolutePath;
        if (startPath) {
          await navigateTo(startPath);
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
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const visibleEntries = useMemo<BrowseEntry[]>(() => {
    if (!browseResult) return [];
    return showHidden
      ? browseResult.entries
      : browseResult.entries.filter((entry) => !entry.hidden);
  }, [browseResult, showHidden]);

  const normalizePath = (path: string): string => path.replace(/\\/g, '/');

  const pickPath = (kind: 'file' | 'directory', absolutePath: string) => {
    onPick({
      kind,
      absolutePath: normalizePath(absolutePath),
    });
    onClose();
  };

  const handleEntryDoubleClick = (entry: BrowseEntry) => {
    if (entry.type === 'directory') {
      void navigateTo(entry.absolutePath);
      return;
    }
    pickPath('file', entry.absolutePath);
  };

  const handlePick = () => {
    if (selectedEntry) {
      pickPath(selectedEntry.type, selectedEntry.absolutePath);
      return;
    }
    if (browseResult) {
      pickPath('directory', browseResult.absolutePath);
    }
  };

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && addressInput.trim() !== '') {
      void navigateTo(addressInput.trim());
    }
  };

  if (!visible) return null;

  const selectedPath = selectedEntry?.absolutePath ?? browseResult?.absolutePath ?? '';
  const pickButtonLabel = selectedEntry
    ? t(language, 'agent.attachmentDialog.addSelected')
    : t(language, 'agent.attachmentDialog.addCurrentFolder');

  return (
    <div className="ws-open-dialog__backdrop" onClick={onClose}>
      <div
        className="ws-open-dialog agent-attachment-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, 'agent.attachmentDialog.title')}
      >
        <div className="ws-open-dialog__header">
          <span>{t(language, 'agent.attachmentDialog.title')}</span>
          <button
            className="ws-open-dialog__close"
            onClick={onClose}
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
            <button className="ws-open-dialog__btn" onClick={onClose} type="button">
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!browseResult && !selectedEntry}
              onClick={handlePick}
              type="button"
            >
              {pickButtonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserAttachmentDialog;
