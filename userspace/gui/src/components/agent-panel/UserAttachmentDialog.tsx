import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentInputAttachmentV3,
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
} from '@deepcode/protocol';
import {
  browsePath,
  createUserAttachmentGrant,
  getInitialLocations,
} from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
import '../workspace-open-dialog/workspaceOpenDialog.css';

interface UserAttachmentDialogProps {
  visible: boolean;
  language: UiLanguage;
  onClose: () => void;
  onPick: (attachment: AgentInputAttachmentV3) => void;
}

const UserAttachmentDialog: React.FC<UserAttachmentDialogProps> = ({
  visible,
  language,
  onClose,
  onPick,
}) => {
  const [locations, setLocations] = useState<InitialLocation[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowsePathResult | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [selected, setSelected] = useState<BrowseEntry | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<AgentInputAttachmentV3['scope']>('message');
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoading(true);
    setError(null);
    setSelected(null);
    const result = await browsePath(absolutePath);
    if (loadGenerationRef.current !== generation) return;
    if (!result.ok || !result.data) {
      setBrowseResult(null);
      setError(result.message ?? t(language, 'agent.attachment.loadFailed'));
      setLoading(false);
      return;
    }
    setBrowseResult(result.data);
    setAddressInput(result.data.absolutePath);
    setLoading(false);
  };

  useEffect(() => {
    if (!visible) {
      loadGenerationRef.current += 1;
      setLocations([]);
      setBrowseResult(null);
      setAddressInput('');
      setSelected(null);
      setQuery('');
      setError(null);
      setCreating(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    setError(null);
    void getInitialLocations().then(async (result) => {
      if (disposed) return;
      if (!result.ok || !result.data) {
        setLoading(false);
        setError(result.message ?? t(language, 'workspaceDialog.error.initialLocations'));
        return;
      }
      setLocations(result.data.locations);
      const first = result.data.locations[0];
      if (!first) {
        setLoading(false);
        return;
      }
      await navigateTo(first.absolutePath);
    });
    return () => {
      disposed = true;
      loadGenerationRef.current += 1;
    };
    // The dialog intentionally starts from Host locations, never workspace state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [creating, onClose, visible]);

  const visibleEntries = useMemo(() => {
    if (!browseResult) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return browseResult.entries.filter((entry) => (
      (showHidden || !entry.hidden)
      && (
        !normalizedQuery
        || entry.name.toLowerCase().includes(normalizedQuery)
        || entry.absolutePath.toLowerCase().includes(normalizedQuery)
      )
    ));
  }, [browseResult, query, showHidden]);

  const pick = async (): Promise<void> => {
    const absolutePath = selected?.absolutePath ?? browseResult?.absolutePath;
    if (!absolutePath) return;
    setCreating(true);
    setError(null);
    const result = await createUserAttachmentGrant({
      absolutePath,
      scope,
      callerRequestId: `host-ui-user-attachment-${globalThis.crypto.randomUUID()}`,
    });
    if (!result.ok || !result.data) {
      setError(result.message ?? t(language, 'agent.attachment.loadFailed'));
      setCreating(false);
      return;
    }
    onPick(result.data.attachment);
    setCreating(false);
    onClose();
  };

  if (!visible) return null;

  const selectedPath = selected?.absolutePath ?? browseResult?.absolutePath ?? '';

  return (
    <div className="ws-open-dialog__backdrop" onClick={creating ? undefined : onClose}>
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
            disabled={creating}
            title={t(language, 'window.close')}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="ws-open-dialog__addressbar agent-attachment-dialog__controls">
          <button
            className="ws-open-dialog__btn"
            type="button"
            disabled={!browseResult?.parentPath || loading || creating}
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
            placeholder={t(language, 'workspaceDialog.addressPlaceholder')}
            disabled={creating}
          />
          <button
            className="ws-open-dialog__btn"
            type="button"
            disabled={!addressInput.trim() || loading || creating}
            onClick={() => void navigateTo(addressInput.trim())}
          >
            {t(language, 'workspaceDialog.go')}
          </button>
          <input
            className="ws-open-dialog__address"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(language, 'agent.attachmentDialog.search')}
            disabled={creating}
          />
          <label className="ws-open-dialog__toggle" title={t(language, 'workspaceDialog.hiddenTitle')}>
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
              disabled={creating}
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
                key={`${location.kind}:${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                type="button"
                disabled={creating}
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {location.kind === 'home' ? 'HOME' : location.kind === 'drive' ? 'DISK' : 'WS'}
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>

          <main className="ws-open-dialog__main agent-attachment-dialog__main">
            {loading && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.loading')}
              </div>
            )}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'agent.attachment.noMatches')}
              </div>
            )}
            {!loading && !error && visibleEntries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {visibleEntries.map((entry) => {
                  const isSelected = selected?.absolutePath === entry.absolutePath;
                  return (
                    <li
                      key={entry.absolutePath}
                      className={`ws-open-dialog__entry${isSelected ? ' ws-open-dialog__entry--selected' : ''}`}
                      onClick={() => setSelected(entry)}
                      onDoubleClick={() => {
                        if (entry.type === 'directory') {
                          void navigateTo(entry.absolutePath);
                        } else {
                          setSelected(entry);
                        }
                      }}
                      title={entry.absolutePath}
                    >
                      <span className="ws-open-dialog__entry-icon">
                        {entry.type === 'directory' ? 'DIR' : 'FILE'}
                      </span>
                      <span className="ws-open-dialog__entry-name">{entry.name}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </main>
        </div>

        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info agent-attachment-dialog__scope">
            <span title={selectedPath}>{t(language, 'workspaceDialog.selected')} {selectedPath}</span>
            <label>
              <input
                type="radio"
                name="attachment-scope"
                value="message"
                checked={scope === 'message'}
                onChange={() => setScope('message')}
                disabled={creating}
              />
              {t(language, 'agent.attachmentDialog.messageScope')}
            </label>
            <label>
              <input
                type="radio"
                name="attachment-scope"
                value="session"
                checked={scope === 'session'}
                onChange={() => setScope('session')}
                disabled={creating}
              />
              {t(language, 'agent.attachmentDialog.sessionScope')}
            </label>
          </div>
          <div className="ws-open-dialog__footer-actions">
            <button
              className="ws-open-dialog__btn"
              onClick={onClose}
              disabled={creating}
              type="button"
            >
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={loading || creating || !selectedPath}
              onClick={() => void pick()}
              type="button"
            >
              {selected
                ? t(language, 'agent.attachmentDialog.addSelected')
                : t(language, 'agent.attachmentDialog.addCurrentFolder')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserAttachmentDialog;
