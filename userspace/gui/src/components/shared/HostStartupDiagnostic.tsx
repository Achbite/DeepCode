import React from 'react';
import type { HostStartupStatusV1 } from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
import './hostStartupDiagnostic.css';

export function HostStartupDiagnostic({ status, language }: { status: HostStartupStatusV1 | null; language: UiLanguage }) {
  if (!status || !['failed', 'blocked'].includes(status.phase)) return null;
  return <section className="host-startup-diagnostic" role="alert">
    <h3>{t(language, 'host.startup.failed')}</h3>
    <p>{status.code}</p>
    <details open>
      <summary>{t(language, 'agent.tool.detail.error')}<span aria-hidden="true">⌄</span></summary>
      <pre tabIndex={0}>{status.message}</pre>
    </details>
    {status.diagnosticRef && <div className="host-startup-diagnostic__log">
      <span>{t(language, 'host.startup.log')}</span><code>{status.diagnosticRef}</code>
    </div>}
  </section>;
}
