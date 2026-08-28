import React, { useState } from 'react';
import type { SettingsSurface } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import CommonSettingsSection from './sections/CommonSettingsSection';
import {
  AgentSettingsSection,
  GuiSettingsSection,
} from './sections/CategorizedSettingsSections';
import LlmSection from './sections/LlmSection';
import WorkspaceSection from './sections/WorkspaceSection';
import './settingsCenter.css';

type SettingsKey = 'workspace' | 'common' | 'gui' | 'agent' | 'llm';

interface SettingsCenterProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  surface?: Extract<SettingsSurface, 'editor' | 'gui'>;
}

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  surface = 'editor',
}) => {
  const [activeKey, setActiveKey] = useState<SettingsKey>(
    surface === 'gui' ? 'gui' : 'workspace',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const language = normalizeUiLanguage(
    useSettingsStore((state) => state.effectiveSettings['workbench.language']),
  );
  const items: Array<{ key: SettingsKey; icon: string; label: string }> = [
    ...(surface === 'editor'
      ? [{ key: 'workspace' as const, icon: 'WS', label: t(language, 'settings.nav.workspace') }]
      : []),
    {
      key: surface === 'gui' ? 'gui' : 'common',
      icon: surface === 'gui' ? 'GU' : 'CM',
      label: t(language, surface === 'gui' ? 'settings.nav.gui' : 'settings.nav.common'),
    },
    { key: 'agent', icon: 'AG', label: t(language, 'settings.nav.agent') },
    { key: 'llm', icon: 'AI', label: t(language, 'settings.nav.llm') },
  ];

  const body = (() => {
    switch (activeKey) {
      case 'workspace':
        return <WorkspaceSection />;
      case 'common':
        return (
          <CommonSettingsSection
            apiStatus={apiStatus}
            wsStatus={wsStatus}
            serverVersion={serverVersion}
            query={searchQuery}
            surface={surface}
          />
        );
      case 'gui':
        return (
          <GuiSettingsSection
            apiStatus={apiStatus}
            wsStatus={wsStatus}
            serverVersion={serverVersion}
            query={searchQuery}
          />
        );
      case 'agent':
        return <AgentSettingsSection query={searchQuery} />;
      case 'llm':
        return <LlmSection />;
    }
  })();

  return (
    <div className="settings-center">
      <nav className="settings-nav">
        <div className="settings-nav__title">{t(language, 'settings.title')}</div>
        <label className="settings-search" aria-label={t(language, 'settings.search.placeholder')}>
          <span>{t(language, 'settings.search.label')}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t(language, 'settings.search.placeholder')}
          />
        </label>
        <div className="settings-nav-group">
          {items.map((item) => (
            <button
              key={item.key}
              className={`settings-nav-item ${
                activeKey === item.key ? 'settings-nav-item--active' : ''
              }`}
              onClick={() => setActiveKey(item.key)}
              type="button"
            >
              <span className="settings-nav-item__icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <section className="settings-body">{body}</section>
    </div>
  );
};

export default SettingsCenter;
