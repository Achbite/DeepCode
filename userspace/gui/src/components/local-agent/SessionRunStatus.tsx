import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
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
        <DeepCodeShellIcon name="spinner" className="local-agent__run-status-spinner" />
      ) : (
        <DeepCodeShellIcon className="local-agent__run-status-icon" name={status === 'completed' ? 'check'
          : status === 'waiting' ? 'pause'
            : status === 'failed' || status === 'releaseFailed' || status === 'indeterminate' ? 'warning'
              : status === 'cancelled' ? 'stop' : 'dot'} />
      )}
      {!compact && <span>{label}</span>}
    </span>
  );
}
