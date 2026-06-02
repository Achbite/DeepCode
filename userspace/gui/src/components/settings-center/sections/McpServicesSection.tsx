import React, { useEffect, useMemo, useState } from 'react';
import { normalizeUiLanguage, t } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';

type McpTransport = 'stdio' | 'http';

interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  description: string;
  enabled: boolean;
  riskAcknowledged: boolean;
}

function safeParseServers(raw: unknown): McpServer[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || `mcp-${Date.now()}`),
        name: String(item.name || 'MCP Server'),
        transport: item.transport === 'http' ? 'http' : 'stdio',
        command: String(item.command || ''),
        args: String(item.args || ''),
        url: String(item.url || ''),
        description: String(item.description || ''),
        enabled: item.enabled !== false,
        riskAcknowledged: item.riskAcknowledged === true,
      }));
  } catch {
    return [];
  }
}

function createServer(): McpServer {
  return {
    id: `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Local MCP Server',
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    description: '',
    enabled: true,
    riskAcknowledged: false,
  };
}

const McpServicesSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const loading = useSettingsStore((s) => s.loading);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);

  const storedServers = useMemo(
    () => safeParseServers(effectiveSettings['mcp.servers']),
    [effectiveSettings]
  );

  const [autoLoad, setAutoLoad] = useState(Boolean(effectiveSettings['mcp.autoLoad'] ?? false));
  const [servers, setServers] = useState<McpServer[]>(storedServers);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAutoLoad(Boolean(effectiveSettings['mcp.autoLoad'] ?? false));
    setServers(storedServers);
  }, [effectiveSettings, storedServers]);

  const updateServer = (id: string, patch: Partial<McpServer>) => {
    setServers((prev) =>
      prev.map((server) => (server.id === id ? { ...server, ...patch } : server))
    );
  };

  const save = async () => {
    setMessage(null);
    await patchUserSetting('mcp.autoLoad', autoLoad);
    await patchUserSetting('mcp.servers', JSON.stringify(servers, null, 2));
    setMessage(t(language, 'settings.mcp.saved'));
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.mcp.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.mcp.runtime')}</h3>
        <div className="settings-card__body">
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {t(language, 'settings.mcp.autoLoad')}
          </label>
          <div className="settings-card__inline-placeholder">
            {t(language, 'settings.mcp.boundary')}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{t(language, 'settings.mcp.servers')}</h3>
          <button
            className="settings-action-button"
            onClick={() => setServers((prev) => [...prev, createServer()])}
            disabled={loading}
            type="button"
          >
            {t(language, 'settings.mcp.addServer')}
          </button>
        </div>

        {servers.length === 0 && (
          <div className="settings-card__hint">{t(language, 'settings.mcp.emptyServers')}</div>
        )}

        <div className="settings-list-editor">
          {servers.map((server) => (
            <div className="mcp-service-row" key={server.id}>
              <div className="mcp-service-row__top">
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={(event) =>
                      updateServer(server.id, { enabled: event.target.checked })
                    }
                  />
                  {t(language, 'settings.common.enabled')}
                </label>
                <input
                  className="settings-field__input"
                  value={server.name}
                  onChange={(event) => updateServer(server.id, { name: event.target.value })}
                  placeholder={t(language, 'settings.mcp.displayName')}
                />
                <select
                  className="settings-field__select"
                  value={server.transport}
                  onChange={(event) =>
                    updateServer(server.id, {
                      transport: event.target.value === 'http' ? 'http' : 'stdio',
                    })
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                </select>
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={server.riskAcknowledged}
                    onChange={(event) =>
                      updateServer(server.id, { riskAcknowledged: event.target.checked })
                    }
                  />
                  {t(language, 'settings.mcp.riskAcknowledged')}
                </label>
                <button
                  className="settings-action-button"
                  onClick={() =>
                    setServers((prev) => prev.filter((item) => item.id !== server.id))
                  }
                  type="button"
                >
                  {t(language, 'settings.common.remove')}
                </button>
              </div>
              <div className="mcp-service-row__grid">
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.command}
                  onChange={(event) => updateServer(server.id, { command: event.target.value })}
                  placeholder={t(language, 'settings.mcp.command')}
                  disabled={server.transport === 'http'}
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.args}
                  onChange={(event) => updateServer(server.id, { args: event.target.value })}
                  placeholder={t(language, 'settings.mcp.args')}
                  disabled={server.transport === 'http'}
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.url}
                  onChange={(event) => updateServer(server.id, { url: event.target.value })}
                  placeholder={t(language, 'settings.mcp.url')}
                  disabled={server.transport === 'stdio'}
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.description}
                  onChange={(event) =>
                    updateServer(server.id, { description: event.target.value })
                  }
                  placeholder={t(language, 'settings.mcp.description')}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="settings-card__footer-row">
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
            type="button"
          >
            {t(language, 'settings.mcp.save')}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default McpServicesSection;
