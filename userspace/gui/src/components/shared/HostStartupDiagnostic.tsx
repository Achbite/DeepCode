import UiIcon from '../../icons/registry';
import React from 'react';
import type { HostStartupStatusV1 } from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
import './hostStartupDiagnostic.css';

export function HostStartupDiagnostic({ status, language, onRetry, busy = false }: { status: HostStartupStatusV1 | null; language: UiLanguage; onRetry?: () => void; busy?: boolean }) {
  if (!status || !['failed', 'blocked'].includes(status.phase)) return null;
  return <section className="host-startup-diagnostic" role="alert">
    <h3>{t(language, 'host.startup.failed')}</h3>
    <p>{status.code}</p>
    <details open>
      <summary>{t(language, 'agent.tool.detail.error')}<UiIcon name="chevronDown" size={14} /></summary>
      <pre tabIndex={0}>{status.message}</pre>
    </details>
    {status.diagnosticRef && <div className="host-startup-diagnostic__log">
      <span>{t(language, 'host.startup.log')}</span><code>{status.diagnosticRef}</code>
    </div>}
    {onRetry && <button type="button" className="settings-button" disabled={busy} onClick={onRetry}>{t(language, busy ? 'deepcodeGui.statusAction.starting' : 'deepcodeGui.statusAction.retry')}</button>}
  </section>;
}
