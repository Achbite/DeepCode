import './internalBrowser.css';
import type React from 'react';
import type { InternalBrowserMode } from '@deepcode/protocol';

interface BrowserModeSwitchProps {
  mode: InternalBrowserMode;
  onChange: (mode: InternalBrowserMode) => void;
}

const BrowserModeSwitch: React.FC<BrowserModeSwitchProps> = ({ mode, onChange }) => (
  <div className="browser-mode-switch" role="tablist" aria-label="Editor mode">
    <button
      className={`browser-mode-switch__item ${mode === 'code' ? 'browser-mode-switch__item--active' : ''}`}
      type="button"
      role="tab"
      aria-selected={mode === 'code'}
      onClick={() => onChange('code')}
    >
      Code
    </button>
    <button
      className={`browser-mode-switch__item ${mode === 'browser' ? 'browser-mode-switch__item--active' : ''}`}
      type="button"
      role="tab"
      aria-selected={mode === 'browser'}
      onClick={() => onChange('browser')}
    >
      Browser
    </button>
  </div>
);

export default BrowserModeSwitch;
