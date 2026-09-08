import React from 'react';
import type { ConversationSessionStatus } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface SessionRunStatusProps {
  run: ConversationSessionStatus['run'];
  language: UiLanguage;
  emptyLabel?: string;
  compact?: boolean;
}

export function SessionRunStatus({ run, language, emptyLabel, compact = false }: SessionRunStatusProps) {
  const status = run?.status ?? 'idle';
  const label = !run
    ? emptyLabel ?? t(language, 'agent.run.status.idle')
    : status === 'waiting' && run.waitingReason
      ? t(language, `agent.activity.waiting.${run.waitingReason}`)
      : t(language, `agent.run.status.${status}`);
  const spinning = status === 'running' || status === 'releasing';
  return (
    <span
      className={`local-agent__run-label local-agent__run-label--${status}${compact ? ' local-agent__run-label--compact' : ''}`}
      role="status"
      aria-label={compact ? label : undefined}
      aria-live={compact ? 'off' : 'polite'}
      title={label}
    >
      {spinning ? (
        <span className="local-agent__run-status-spinner" aria-hidden="true" />
      ) : (
        <svg className="local-agent__run-status-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {status === 'completed' ? <path d="m3.5 8 3 3 6-6" />
            : status === 'waiting' ? <><circle cx="8" cy="8" r="5.75" /><path d="M6.25 5.75v4.5m3.5-4.5v4.5" /></>
              : status === 'failed' || status === 'releaseFailed' || status === 'indeterminate'
                ? <><circle cx="8" cy="8" r="5.75" /><path d="M8 4.75v3.5M8 11h0" /></>
                : status === 'cancelled' ? <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
                  : <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />}
        </svg>
      )}
      {!compact && <span>{label}</span>}
    </span>
  );
}
