import React, { useEffect, useMemo, useState } from 'react';
import type { BrowseEntry, BrowsePathResult, InitialLocation } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { browsePath, getInitialLocations } from '../../services/runtimeAdapter';
import '../../components/workspace-open-dialog/workspaceOpenDialog.css';

interface ProjectFolderDialogProps {
  language: UiLanguage;
  onCancel: () => void;
  onSelect: (absolutePath: string, type: BrowseEntry['type']) => void;
  selectionMode?: 'directory' | 'messageAttachment';
}

const ProjectFolderDialog: React.FC<ProjectFolderDialogProps> = ({
  language,
  onCancel,
  onSelect,
  selectionMode = 'directory',
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
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const result = await getInitialLocations();
      if (cancelled) return;
      if (!result.ok || !result.data) {
        setError(result.message ?? t(language, 'workspaceDialog.error.initialLocations'));
        setLoading(false);
        return;
      }
      setLocations(result.data.locations);
      const first = result.data.locations[0];
      if (first) await navigateTo(first.absolutePath);
      else setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // navigateTo deliberately remains local to this modal instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const isAttachmentSelection = selectionMode === 'messageAttachment';
  const entries = useMemo(
    () => (browseResult?.entries ?? []).filter((entry) => (
      (showHidden || !entry.hidden)
      && (isAttachmentSelection || entry.type === 'directory')
    )),
    [browseResult, isAttachmentSelection, showHidden],
  );
  const selectedPath = selectedEntry?.absolutePath ?? browseResult?.absolutePath ?? '';
  const selectedType = selectedEntry?.type ?? 'directory';

  return (
    <div className="ws-open-dialog__backdrop" onClick={onCancel}>
      <div
        className={`ws-open-dialog${isAttachmentSelection ? ' ws-open-dialog--message-attachment' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, isAttachmentSelection
          ? 'agent.attachment.pickerTitle'
          : 'deepcodeGui.project.folderDialogTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ws-open-dialog__header">
          <span>
            <strong>{t(language, isAttachmentSelection
              ? 'agent.attachment.pickerTitle'
              : 'deepcodeGui.project.folderDialogTitle')}</strong>
            {isAttachmentSelection && (
              <small>{t(language, 'agent.attachment.pickerDescription')}</small>
            )}
          </span>
          <button
            type="button"
            className="ws-open-dialog__close"
            aria-label={t(language, 'workspaceDialog.cancel')}
            onClick={onCancel}
          >×</button>
        </div>
        <div className="ws-open-dialog__addressbar">
          <button
            type="button"
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && void navigateTo(browseResult.parentPath)}
          >
            {t(language, 'workspaceDialog.up')}
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && addressInput.trim()) {
                void navigateTo(addressInput.trim());
              }
            }}
          />
          <button
            type="button"
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && void navigateTo(addressInput.trim())}
          >
            {t(language, 'workspaceDialog.go')}
          </button>
          <label className="ws-open-dialog__toggle">
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
                type="button"
                key={`${location.kind}:${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {t(language, `workspaceDialog.locationKind.${location.kind}`)}
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>
          <main className="ws-open-dialog__main">
            {loading && <div className="ws-open-dialog__placeholder">{t(language, 'workspaceDialog.loading')}</div>}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && entries.length === 0 && (
              <div className="ws-open-dialog__placeholder">{t(language, 'workspaceDialog.empty')}</div>
            )}
            {!loading && !error && entries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {entries.map((entry) => (
                  <li
                    key={entry.absolutePath}
                    className={`ws-open-dialog__entry${selectedEntry?.absolutePath === entry.absolutePath ? ' ws-open-dialog__entry--selected' : ''}`}
                    onClick={() => setSelectedEntry(entry)}
                    onDoubleClick={() => {
                      if (entry.type === 'directory') {
                        void navigateTo(entry.absolutePath);
                      } else if (isAttachmentSelection) {
                        onSelect(entry.absolutePath, entry.type);
                      }
                    }}
                    title={entry.absolutePath}
                  >
                    <span className="ws-open-dialog__entry-icon">
                      {t(language, `workspaceDialog.entryKind.${entry.type}`)}
                    </span>
                    <span className="ws-open-dialog__entry-name">{entry.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </div>
        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info" title={selectedPath}>{selectedPath}</div>
          <div className="ws-open-dialog__footer-actions">
            <button type="button" className="ws-open-dialog__btn" onClick={onCancel}>
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              type="button"
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!selectedPath || !selectedType}
              onClick={() => selectedPath && selectedType && onSelect(selectedPath, selectedType)}
            >
              {t(language, isAttachmentSelection
                ? 'agent.attachment.attachSelected'
                : 'workspaceDialog.openSelectedFolder')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectFolderDialog;
