import { SettingsSearchContext, SettingsSearchTargets, matchesSettingsQuery, type SettingsSearchEntry } from './settingsSearch';
import { settingsSearchDefinitions } from './sections/CategorizedSettingsSections';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsSurface } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import CommonSettingsSection from './sections/CommonSettingsSection';
import {
  AgentSettingsSection,
  GuiSettingsSection,
} from './sections/CategorizedSettingsSections';
import LlmSection from './sections/LlmSection';
import ModelUsageSettings from './ModelUsageSettings';
import WorkspaceSection from './sections/WorkspaceSection';
import PluginsSection from './sections/PluginsSection';
import DeepCodeShellIcon, { type DeepCodeShellIconName } from '../shared/DeepCodeShellIcon';
import './settingsCenter.css';

type SettingsKey = 'general' | 'about' | 'workspace' | 'common' | 'gui' | 'agent' | 'environment' | 'permissions' | 'llm' | 'plugins';

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
  const [searchEntries, setSearchEntries] = useState<Record<string, SettingsSearchEntry[]>>({});
  const register = useCallback((owner: string, entries: SettingsSearchEntry[]) => setSearchEntries((current) => ({ ...current, [owner]: entries })), []);
  const targets = useRef(new Map<string, HTMLElement>());
  const pendingTarget = useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [visited, setVisited] = useState<SettingsKey[]>([surface === 'gui' ? 'gui' : 'workspace']);
  const language = normalizeUiLanguage(
    useSettingsStore((state) => state.effectiveSettings['workbench.language']),
  );
  const statusText = (value: string) => ['connected', 'disconnected', 'checking'].includes(value)
    ? t(language, `deepcodeGui.status.${value}`) : value;
  const items: Array<{ key: SettingsKey; icon: DeepCodeShellIconName; label: string }> = [
    ...(surface === 'editor'
      ? [{ key: 'workspace' as const, icon: 'folder' as const, label: t(language, 'settings.nav.workspace') }]
      : []),
    ...(surface === 'gui' ? [{ key: 'general' as const, icon: 'settings' as const, label: language === 'zh-CN' ? '通用' : 'General' }] : []),
    {
      key: surface === 'gui' ? 'gui' : 'common',
      icon: 'settings',
      label: t(language, surface === 'gui' ? 'settings.nav.gui' : 'settings.nav.common'),
    },
    { key: 'agent', icon: 'session', label: t(language, 'settings.nav.agent') },
    { key: 'environment', icon: 'terminal', label: t(language, 'settings.nav.environment') },
    { key: 'permissions', icon: 'tool', label: t(language, 'settings.nav.permissions') },
    { key: 'llm', icon: 'activity', label: t(language, 'settings.nav.llm') },
    { key: 'plugins', icon: 'extension', label: t(language, 'settings.nav.plugins') },
    ...(surface === 'gui' ? [{ key: 'about' as const, icon: 'activity' as const, label: language === 'zh-CN' ? '关于' : 'About' }] : []),
  ];

  const searching = !!searchQuery.trim();
  const environment = useSettingsStore((state) => state.environment);
  const definitions = settingsSearchDefinitions(language, environment?.os);
  const entries = [
    ...items.map((item) => ({ id: `page-${item.key}`, title: item.label, category: item.key, keywords: t(language, `settings.search.terms.${item.key}`) })),
    ...definitions,
    ...Object.values(searchEntries).flat(),
  ];
  const matches = entries.filter((entry) => items.some((item) => item.key === entry.category) && matchesSettingsQuery(searchQuery, entry.title, entry.keywords ?? ''));
  const navigate = (key: SettingsKey, target?: string) => {
    pendingTarget.current = target ?? null;
    setActiveKey(key); setSearchQuery('');
    setVisited((current) => current.includes(key) ? current : [...current, key]);
  };
  useEffect(() => {
    if (searching) setVisited((current) => [...new Set([...current, ...items.map((item) => item.key)])]);
  }, [searching, surface]);
  useEffect(() => {
    if (searching || !pendingTarget.current) return;
    const element = targets.current.get(pendingTarget.current) ?? document.getElementById(`setting-${pendingTarget.current}`);
    if (element) { element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }); pendingTarget.current = null; }
  }, [searching, activeKey, visited]);

  const body = (key: SettingsKey) => {
    switch (key) {
      case 'workspace':
        return <WorkspaceSection />;
      case 'common':
        return (
          <CommonSettingsSection
            apiStatus={statusText(apiStatus)}
            wsStatus={statusText(wsStatus)}
            serverVersion={serverVersion}
            query=""
            surface={surface}
          />
        );
      case 'general':
      case 'about':
      case 'gui':
        return (
          <GuiSettingsSection
            category={key === 'gui' ? 'appearance' : key}
            apiStatus={statusText(apiStatus)}
            wsStatus={statusText(wsStatus)}
            serverVersion={serverVersion}
            query=""
          />
        );
      case 'agent':
      case 'environment':
      case 'permissions':
        return <AgentSettingsSection category={key} query="" />;
      case 'llm':
        return <div className="settings-services"><LlmSection /><AgentSettingsSection category="services" query="" /><ModelUsageSettings language={language} /></div>;
      case 'plugins':
        return <PluginsSection query="" />;
    }
  };

  return (
    <SettingsSearchTargets.Provider value={targets.current}><SettingsSearchContext.Provider value={register}><div className="settings-center">
      <nav className="settings-nav" aria-label={t(language, 'settings.title')}>
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
              onClick={() => navigate(item.key)}
              aria-current={!searching && activeKey === item.key ? 'page' : undefined}
              type="button"
            >
              <span className="settings-nav-item__icon"><DeepCodeShellIcon name={item.icon} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <section className="settings-body">
        {searching && <div className="settings-search-results">
          <h2 className="settings-title">{t(language, 'settings.search.results')}</h2>
          <p role="status">{t(language, 'settings.search.count', { count: matches.length })}</p>
          {matches.map((entry) => <button key={entry.id} type="button" className="settings-search-result" onClick={() => navigate(entry.category as SettingsKey, entry.id)}>
            <strong>{entry.title}</strong><span>{items.find((item) => item.key === entry.category)?.label}</span>
          </button>)}
          {!matches.length && <p>{t(language, 'settings.noSearchMatch')}</p>}
        </div>}
        {visited.map((key) => <div className="settings-page" id={`setting-page-${key}`} tabIndex={-1} key={key} hidden={searching || key !== activeKey}>{body(key)}</div>)}
      </section>
    </div></SettingsSearchContext.Provider></SettingsSearchTargets.Provider>
  );
};

export default SettingsCenter;
