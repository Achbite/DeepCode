import React, { useState } from 'react';
import { getConversationArchive } from '../../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../../state/agentSessionStore';
import { useWorkspaceStore } from '../../../state/workspaceStore';
import { useUiStore } from '../../../state/uiStore';
import SettingsField from '../SettingsField';
import {
  SETTING_DEFINITIONS,
  useSettingsStore,
} from '../../../state/settingsStore';
import type { UserSettingValue } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../../i18n';
import { localizeSettingDefinition } from '../../../settingsLocalization';

const WorkspaceSection: React.FC = () => {
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const lastError = useWorkspaceStore((s) => s.lastError);
  const saveWorkspaceFile = useWorkspaceStore((s) => s.saveWorkspaceFile);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const sources = useSettingsStore((s) => s.sources);
  const patchWorkspaceSetting = useSettingsStore((s) => s.patchWorkspaceSetting);
  const currentAgentSessionId = useAgentSessionStore((s) => s.session?.id);

  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [archiveMessage, setArchiveMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const handleWorkspaceSettingChange = (key: string, value: UserSettingValue) => {
    void patchWorkspaceSetting(key, value);
  };

  const handleSaveWorkspaceFile = async () => {
    setSaveMessage(null);
    const result = await saveWorkspaceFile();
    if (result.ok) {
      setSaveMessage(`已保存: ${result.path}`);
      return;
    }
    setSaveMessage(result.message ?? '保存 workspace 文件失败');
  };

  const handleCopyArchivePath = async () => {
    setArchiveMessage(null);
    if (!currentAgentSessionId) {
      setArchiveMessage({ kind: 'error', text: t(language, 'workspace.archiveNoSession') });
      return;
    }

    const result = await getConversationArchive(currentAgentSessionId);
    const archivePath = result.data?.archives[0]?.archivePath ?? result.data?.conversationArchiveRoot;
    if (!result.ok || !archivePath) {
      setArchiveMessage({
        kind: 'error',
        text: result.message ?? result.error ?? t(language, 'workspace.archiveUnavailable'),
      });
      return;
    }

    await copyText(archivePath);
    setArchiveMessage({
      kind: 'info',
      text: t(language, 'workspace.archiveCopied', { path: archivePath }),
    });
  };

  if (!workspace) {
    return (
      <div>
        <h2 className="settings-title">{t(language, 'workspace.title')}</h2>
        <div className="settings-card">
          <div className="settings-card__header-row">
            <h3 className="settings-card__title">
              {t(language, 'workspace.noneTitle')}
            </h3>
            <button
              className="settings-action-button"
              onClick={showWorkspaceOpenDialog}
              type="button"
            >
              {t(language, 'workspace.openFolder')}
            </button>
          </div>
          <div className="settings-card__body">
            {t(language, 'workspace.noneBody')}
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card__header-row">
            <h3 className="settings-card__title">
              {t(language, 'workspace.archiveTitle')}
            </h3>
            <button
              className="settings-action-button"
              disabled={!currentAgentSessionId}
              onClick={() => void handleCopyArchivePath()}
              type="button"
            >
              {t(language, 'workspace.archiveCopyPath')}
            </button>
          </div>
          <div className="settings-card__body">
            {t(language, 'workspace.archiveBody')}
          </div>
          {archiveMessage && (
            <div
              className={
                archiveMessage.kind === 'error'
                  ? 'settings-status settings-status--error'
                  : 'settings-status'
              }
            >
              {archiveMessage.text}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="settings-title">{t(language, 'workspace.title')}</h2>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">
            {t(language, 'workspace.currentTitle')}
          </h3>
          <div className="settings-action-row">
            <button
              className="settings-action-button"
              onClick={showWorkspaceOpenDialog}
              type="button"
            >
              {t(language, 'workspace.openFolder')}
            </button>
            <button
              className="settings-action-button"
              onClick={() => void handleSaveWorkspaceFile()}
              type="button"
            >
              {t(language, 'workspace.saveFile')}
            </button>
          </div>
        </div>

        <table className="settings-kv">
          <tbody>
            <tr>
              <td>{t(language, 'workspace.name')}</td>
              <td>{workspace.name}</td>
            </tr>
            <tr>
              <td>ID</td>
              <td>{workspace.id}</td>
            </tr>
            <tr>
              <td>{t(language, 'workspace.source')}</td>
              <td>
                {workspace.source}
                {fallbackUsed && (
                  <span className="settings-source-note">
                    {t(language, 'workspace.fallback')}
                  </span>
                )}
              </td>
            </tr>
            {workspace.sourcePath && (
              <tr>
                <td>{t(language, 'workspace.file')}</td>
                <td className="settings-path">{workspace.sourcePath}</td>
              </tr>
            )}
            <tr>
              <td>{t(language, 'workspace.openedAt')}</td>
              <td>{workspace.openedAt}</td>
            </tr>
          </tbody>
        </table>

        {(lastError || saveMessage || archiveMessage) && (
          <div
            className={
              lastError || archiveMessage?.kind === 'error'
                ? 'settings-status settings-status--error'
                : 'settings-status'
            }
          >
            {lastError ?? saveMessage ?? archiveMessage?.text}
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">
            {t(language, 'workspace.archiveTitle')}
          </h3>
          <button
            className="settings-action-button"
            disabled={!currentAgentSessionId}
            onClick={() => void handleCopyArchivePath()}
            type="button"
          >
            {t(language, 'workspace.archiveCopyPath')}
          </button>
        </div>
        <div className="settings-card__body">
          {t(language, 'workspace.archiveBody')}
        </div>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">
          {t(language, 'workspace.folders')} ({workspace.folders.length})
        </h3>
        <table className="settings-kv">
          <tbody>
            {workspace.folders.map((folder) => (
              <tr key={folder.id}>
                <td>{folder.id}</td>
                <td>
                  <div>
                    <strong>{folder.name}</strong>
                  </div>
                  <div className="settings-path">{folder.absolutePath}</div>
                  {!folder.isAbsolute && (
                    <div className="settings-path">
                      {t(language, 'workspace.relativePrefix')}
                      {folder.originalPath}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">
          {t(language, 'workspace.deepcodeSettings')}
        </h3>
        <div className="settings-card__body">
          {t(language, 'workspace.deepcodeSettingsBody')}
        </div>
        <div className="settings-workspace-fields">
          {SETTING_DEFINITIONS.map((definition) => localizeSettingDefinition(definition, language)).map((definition) => (
            <SettingsField
              key={definition.key}
              definition={definition}
              value={effectiveSettings[definition.key]}
              source={sources[definition.key] ?? 'default'}
              language={language}
              onChange={handleWorkspaceSettingChange}
            />
          ))}
        </div>
        {Object.keys(workspace.settings).length > 0 && (
          <details className="settings-raw-details">
            <summary>{t(language, 'workspace.rawSettings')}</summary>
            <table className="settings-kv">
              <tbody>
                {Object.entries(workspace.settings).map(([key, value]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>
                      <code>{JSON.stringify(value)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      {workspace.unsupportedFields.length > 0 && (
        <div className="settings-card">
          <h3 className="settings-card__title">
            {t(language, 'workspace.unsupportedFields')}
          </h3>
          <table className="settings-kv">
            <tbody>
              {workspace.unsupportedFields.map((field) => (
                <tr key={field.key}>
                  <td>{field.key}</td>
                  <td>{field.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="settings-card__body">
            {t(language, 'workspace.unsupportedBody')}
          </div>
        </div>
      )}
    </div>
  );
};

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export default WorkspaceSection;
