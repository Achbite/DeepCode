import React, { useEffect, useMemo, useState } from 'react';
import { normalizeUiLanguage } from '../../../i18n';
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

function newServer(): McpServer {
  return {
    id: `mcp-${Date.now().toString(36)}`,
    name: 'Local MCP',
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
  const zh = language === 'zh-CN';
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
    setMessage(zh ? '已保存；重启本地 Daemon 后生效。' : 'Saved; restart the local daemon to apply.');
  };

  return (
    <div>
      <h2 className="settings-title">MCP</h2>
      <div className="settings-card">
        <div className="settings-card__body">
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {zh ? '启动本地 stdio MCP Server' : 'Start local stdio MCP servers'}
          </label>
          <p className="settings-card__hint">
            {zh
              ? 'MCP 工具并入同一个工具目录，并沿同一 Kernel 执行与用户决定路径运行。'
              : 'MCP tools join the same tool catalog and use the same Kernel execution and user-decision path.'}
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{zh ? '本地服务' : 'Local servers'}</h3>
          <button
            type="button"
            className="settings-action-button"
            onClick={() => setServers((current) => [...current, newServer()])}
            disabled={loading}
          >
            {zh ? '添加' : 'Add'}
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
                  {zh ? '启用' : 'Enabled'}
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
                  placeholder={zh ? '显示名称' : 'Display name'}
                />
                <button
                  type="button"
                  className="settings-action-button"
                  onClick={() => setServers((current) =>
                    current.filter((candidate) => candidate !== server))}
                >
                  {zh ? '移除' : 'Remove'}
                </button>
              </div>
              <div className="mcp-service-row__grid">
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.command}
                  onChange={(event) => update(server.id, { command: event.target.value })}
                  placeholder={zh ? '可执行文件绝对路径或命令' : 'Executable path or command'}
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={server.args}
                  onChange={(event) => update(server.id, { args: event.target.value })}
                  placeholder={zh ? '参数字符串' : 'Argument string'}
                />
              </div>
            </div>
          ))}
          {servers.length === 0 && (
            <div className="settings-card__hint">{zh ? '尚未配置 MCP Server。' : 'No MCP servers configured.'}</div>
          )}
        </div>
        <div className="settings-card__footer-row">
          <button
            type="button"
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
          >
            {zh ? '保存' : 'Save'}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default McpServicesSection;
