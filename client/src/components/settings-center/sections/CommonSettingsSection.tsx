/**
 * Common Settings 板块（Settings 中心）
 *
 * 阶段 5：接入真实用户设置表单，并显示三层设置叠加后的来源。
 */
import React, { useMemo } from 'react';
import SettingsField from '../SettingsField';
import {
  SETTING_DEFINITIONS,
  useSettingsStore,
  type SettingDefinition,
} from '../../../state/settingsStore';
import type { UserSettingValue } from '@deepcode/protocol';

interface CommonSettingsSectionProps {
  serverVersion?: string;
  apiStatus: string;
  wsStatus: string;
}

function groupDefinitions(): Record<string, SettingDefinition[]> {
  return SETTING_DEFINITIONS.reduce<Record<string, SettingDefinition[]>>(
    (acc, item) => {
      if (!acc[item.group]) acc[item.group] = [];
      acc[item.group].push(item);
      return acc;
    },
    {}
  );
}

const GROUP_TITLES: Record<string, string> = {
  editor: 'Editor',
  files: 'Files',
  keyboard: 'Keyboard',
  explorer: 'Explorer',
  workbench: 'Workbench',
  terminal: 'Terminal',
  agent: 'Agent',
};

const CommonSettingsSection: React.FC<CommonSettingsSectionProps> = ({
  serverVersion,
  apiStatus,
  wsStatus,
}) => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const sources = useSettingsStore((s) => s.sources);
  const loading = useSettingsStore((s) => s.loading);
  const errorMessage = useSettingsStore((s) => s.errorMessage);
  const storePath = useSettingsStore((s) => s.storePath);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const resetUserSetting = useSettingsStore((s) => s.resetUserSetting);

  const grouped = useMemo(() => groupDefinitions(), []);

  const handleChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };

  return (
    <div>
      <h2 className="settings-title">Common Settings</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">运行时信息</h3>
        <table className="settings-kv">
          <tbody>
            <tr>
              <td>产品名</td>
              <td>DeepCode</td>
            </tr>
            <tr>
              <td>服务端版本</td>
              <td>{serverVersion ?? '—'}</td>
            </tr>
            <tr>
              <td>API 状态</td>
              <td>{apiStatus}</td>
            </tr>
            <tr>
              <td>WebSocket 状态</td>
              <td>{wsStatus}</td>
            </tr>
            <tr>
              <td>用户设置文件</td>
              <td>{storePath ?? '尚未加载'}</td>
            </tr>
          </tbody>
        </table>
        {errorMessage && (
          <div className="settings-error">{errorMessage}</div>
        )}
      </div>

      {Object.entries(grouped).map(([group, definitions]) => (
        <div className="settings-card" key={group}>
          <h3 className="settings-card__title">{GROUP_TITLES[group] ?? group}</h3>
          <div className="settings-card__body">
            {definitions.map((definition) => (
              <SettingsField
                key={definition.key}
                definition={definition}
                value={effectiveSettings[definition.key]}
                source={sources[definition.key] ?? 'default'}
                disabled={loading || sources[definition.key] === 'workspace'}
                onChange={handleChange}
                onReset={(key) => void resetUserSetting(key)}
              />
            ))}
          </div>
          <div className="settings-card__hint">
            Workspace 来源的值由当前工作区覆盖，需到 Workspace 板块调整。
          </div>
        </div>
      ))}
    </div>
  );
};

export default CommonSettingsSection;
