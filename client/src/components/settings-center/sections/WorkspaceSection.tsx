import React, { useState } from 'react';
import { useWorkspaceStore } from '../../../state/workspaceStore';
import { useUiStore } from '../../../state/uiStore';
import SettingsField from '../SettingsField';
import {
  SETTING_DEFINITIONS,
  useSettingsStore,
} from '../../../state/settingsStore';
import type { UserSettingValue } from '@deepcode/protocol';

const WorkspaceSection: React.FC = () => {
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const lastError = useWorkspaceStore((s) => s.lastError);
  const saveWorkspaceFile = useWorkspaceStore((s) => s.saveWorkspaceFile);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const sources = useSettingsStore((s) => s.sources);
  const patchWorkspaceSetting = useSettingsStore((s) => s.patchWorkspaceSetting);

  const [saveMessage, setSaveMessage] = useState<string | null>(null);

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

  if (!workspace) {
    return (
      <div>
        <h2 className="settings-title">Workspace</h2>
        <div className="settings-card">
          <div className="settings-card__header-row">
            <h3 className="settings-card__title">No Workspace Opened</h3>
            <button
              className="settings-action-button"
              onClick={showWorkspaceOpenDialog}
              type="button"
            >
              Open Folder...
            </button>
          </div>
          <div className="settings-card__body">
            DeepCode will stay empty until you open a folder or a .code-workspace file.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="settings-title">Workspace</h2>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">Current Workspace</h3>
          <div className="settings-action-row">
            <button
              className="settings-action-button"
              onClick={showWorkspaceOpenDialog}
              type="button"
            >
              Open Folder...
            </button>
            <button
              className="settings-action-button"
              onClick={() => void handleSaveWorkspaceFile()}
              type="button"
            >
              Save Workspace File
            </button>
          </div>
        </div>

        <table className="settings-kv">
          <tbody>
            <tr>
              <td>Name</td>
              <td>{workspace.name}</td>
            </tr>
            <tr>
              <td>ID</td>
              <td>{workspace.id}</td>
            </tr>
            <tr>
              <td>Source</td>
              <td>
                {workspace.source}
                {fallbackUsed && <span className="settings-source-note">fallback</span>}
              </td>
            </tr>
            {workspace.sourcePath && (
              <tr>
                <td>Workspace File</td>
                <td className="settings-path">{workspace.sourcePath}</td>
              </tr>
            )}
            <tr>
              <td>Opened At</td>
              <td>{workspace.openedAt}</td>
            </tr>
          </tbody>
        </table>

        {(lastError || saveMessage) && (
          <div
            className={
              lastError ? 'settings-status settings-status--error' : 'settings-status'
            }
          >
            {lastError ?? saveMessage}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">Folders ({workspace.folders.length})</h3>
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
                    <div className="settings-path">Relative: {folder.originalPath}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">DeepCode Workspace Settings</h3>
        <div className="settings-card__body">
          这些设置保存在当前工作区上下文中；保存为 .code-workspace 后会写入 workspace 文件的 settings 字段。
        </div>
        <div className="settings-workspace-fields">
          {SETTING_DEFINITIONS.map((definition) => (
            <SettingsField
              key={definition.key}
              definition={definition}
              value={effectiveSettings[definition.key]}
              source={sources[definition.key] ?? 'default'}
              onChange={handleWorkspaceSettingChange}
            />
          ))}
        </div>
        {Object.keys(workspace.settings).length > 0 && (
          <details className="settings-raw-details">
            <summary>Raw deepcode.* settings</summary>
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
          <h3 className="settings-card__title">Unsupported Workspace Fields</h3>
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
            DeepCode 当前不解析 VSCode 专用字段，例如 extensions、tasks、launch、remoteAuthority。
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspaceSection;
