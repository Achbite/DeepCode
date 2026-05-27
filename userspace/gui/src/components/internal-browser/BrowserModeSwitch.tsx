import './internalBrowser.css';
import type React from 'react';
import type { InternalBrowserMode } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface BrowserModeSwitchProps {
  mode: InternalBrowserMode;
  language: UiLanguage;
  onChange: (mode: InternalBrowserMode) => void;
}

const BrowserModeSwitch: React.FC<BrowserModeSwitchProps> = ({ mode, language, onChange }) => (
  <div className="browser-mode-switch" role="tablist" aria-label={t(language, 'workbench.mode.aria')}>
    <button
      className={`browser-mode-switch__item ${mode === 'code' ? 'browser-mode-switch__item--active' : ''}`}
      type="button"
      role="tab"
      aria-selected={mode === 'code'}
      onClick={() => onChange('code')}
    >
      {t(language, 'workbench.mode.code')}
    </button>
    <button
      className={`browser-mode-switch__item ${mode === 'browser' ? 'browser-mode-switch__item--active' : ''}`}
      type="button"
      role="tab"
      aria-selected={mode === 'browser'}
      onClick={() => onChange('browser')}
    >
      {t(language, 'workbench.mode.browser')}
    </button>
  </div>
);

export default BrowserModeSwitch;
