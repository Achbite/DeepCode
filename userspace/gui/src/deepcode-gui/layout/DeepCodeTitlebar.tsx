import React from 'react';
import WindowControls from '../../components/window-controls/WindowControls';
import { t, type UiLanguage } from '../../i18n';
import { statusLabel } from './DeepCodeShellText';

export interface DeepCodeCacheHitSummary {
  label: string;
  title: string;
}

interface DeepCodeTitlebarProps {
  language: UiLanguage;
  apiStatus: string;
  agentReady: boolean;
  cacheHitSummary: DeepCodeCacheHitSummary | null;
  kernelStartBusy: boolean;
  kernelStartMessage?: string | null;
  onRetryKernelStart?: () => void | Promise<void>;
}

const DeepCodeTitlebar: React.FC<DeepCodeTitlebarProps> = ({
  language,
  apiStatus,
  agentReady,
  cacheHitSummary,
  kernelStartBusy,
  kernelStartMessage,
  onRetryKernelStart,
}) => (
  <header className="deepcode-gui-titlebar" data-tauri-drag-region>
    <div className="deepcode-gui-titlebar__brand">
      <span className="deepcode-gui-titlebar__mark">DC</span>
      <span>DeepCode-GUI</span>
    </div>
    <div className="deepcode-gui-titlebar__status">
      {cacheHitSummary && (
        <span
          className="deepcode-gui-status-pill deepcode-gui-status-pill--cache"
          title={cacheHitSummary.title}
        >
          {cacheHitSummary.label}
        </span>
      )}
      {apiStatus !== 'connected' && onRetryKernelStart && (
        <button
          type="button"
          className="deepcode-gui-status-pill deepcode-gui-status-pill--button"
          title={kernelStartMessage ?? undefined}
          disabled={kernelStartBusy}
          onClick={() => void onRetryKernelStart()}
        >
          {kernelStartBusy
            ? t(language, 'deepcodeGui.statusAction.starting')
            : t(language, 'deepcodeGui.statusAction.retry')}
        </button>
      )}
      <span className={`deepcode-gui-status-pill deepcode-gui-status-pill--${apiStatus}`}>
        API {statusLabel(language, apiStatus)}
      </span>
      <span className={`deepcode-gui-status-pill deepcode-gui-status-pill--${agentReady ? 'ready' : 'checking'}`}>
        Agent {statusLabel(language, agentReady ? 'ready' : 'checking')}
      </span>
    </div>
    <WindowControls language={language} />
  </header>
);

export default DeepCodeTitlebar;
