import React, { useEffect, useMemo, useState } from 'react';
import { normalizeUiLanguage, t, type UiLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';

interface McpServer {
  id: string;
  name: string;
  transport: 'stdio';
  command: string;
  args: string;
  enabled: boolean;
}

function parseServers(value: unknown): McpServer[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.command !== 'string') return [];
      return [{
        id: record.id,
        name: typeof record.name === 'string' ? record.name : record.id,
        transport: 'stdio' as const,
        command: record.command,
        args: typeof record.args === 'string' ? record.args : '',
        enabled: record.enabled !== false,
      }];
    });
  } catch {
    return [];
  }
}

function newServer(language: UiLanguage): McpServer {
  return {
    id: `mcp-${Date.now().toString(36)}`,
    name: t(language, 'settings.mcp.defaultName'),
    transport: 'stdio',
    command: '',
    args: '',
    enabled: true,
  };
}

const McpServicesSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const stored = useMemo(
    () => parseServers(effectiveSettings['mcp.servers']),
    [effectiveSettings],
  );
  const [autoLoad, setAutoLoad] = useState(Boolean(effectiveSettings['mcp.autoLoad']));
  const [servers, setServers] = useState(stored);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAutoLoad(Boolean(effectiveSettings['mcp.autoLoad']));
    setServers(stored);
  }, [effectiveSettings, stored]);

  const update = (id: string, patch: Partial<McpServer>) => {
    setServers((current) => current.map((server) =>
      server.id === id ? { ...server, ...patch } : server));
  };

  const save = async () => {
    setMessage(null);
    await patchUserSetting('mcp.autoLoad', autoLoad);
    await patchUserSetting('mcp.servers', JSON.stringify(servers, null, 2));
    setMessage(t(language, 'settings.runtime.restartDaemonAfterSave'));
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.mcp.title')}</h2>
      <div className="settings-card">
        <div className="settings-card__body">
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {t(language, 'settings.mcp.autoLoad')}
          </label>
          <p className="settings-card__hint">
            {t(language, 'settings.mcp.scopeHint')}
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{t(language, 'settings.mcp.localServers')}</h3>
          <button
            type="button"
            className="settings-action-button"
            onClick={() => setServers((current) => [...current, newServer(language)])}
            disabled={loading}
          >
            {t(language, 'settings.common.add')}
          </button>
        </div>
        <div className="settings-list-editor">
          {servers.map((server) => (
            <div className="mcp-service-row" key={server.id}>
              <div className="mcp-service-row__top">
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={(event) => update(server.id, { enabled: event.target.checked })}
                  />
                  {t(language, 'settings.common.enabled')}
                </label>
                <input
                  className="settings-field__input"
                  value={server.id}
                  onChange={(event) => update(server.id, { id: event.target.value })}
                  placeholder="server-id"
                />
                <input
                  className="settings-field__input"
                  value={server.name}
                  onChange={(event) => update(server.id, { name: event.target.value })}
                  placeholder={t(language, 'settings.mcp.displayName')}
                />
                <button
                  type="button"
                  className="settings-action-button"
                  onClick={() => setServers((current) =>
                    current.filter((candidate) => candidate !== server))}
                >
                  {t(language, 'settings.common.remove')}
                </button>
              </div>
              <div className="mcp-service-row__grid">
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.command}
                  onChange={(event) => update(server.id, { command: event.target.value })}
                  placeholder={t(language, 'settings.mcp.commandPlaceholder')}
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.args}
                  onChange={(event) => update(server.id, { args: event.target.value })}
                  placeholder={t(language, 'settings.mcp.argsPlaceholder')}
                />
              </div>
            </div>
          ))}
          {servers.length === 0 && (
            <div className="settings-card__hint">{t(language, 'settings.mcp.empty')}</div>
          )}
        </div>
        <div className="settings-card__footer-row">
          <button
            type="button"
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
          >
            {t(language, 'settings.common.save')}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default McpServicesSection;
