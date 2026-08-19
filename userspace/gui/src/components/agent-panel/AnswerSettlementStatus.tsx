import React from 'react';
import type {
  AgentTimelineAnswerState,
  AgentTimelineDeliveryMode,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

export function isAnswerPlaybackIncremental(
  deliveryMode: AgentTimelineDeliveryMode | undefined,
  answerState: AgentTimelineAnswerState | undefined
): boolean {
  if (answerState !== undefined && answerState !== 'streaming') return false;
  return deliveryMode === 'live' || deliveryMode === 'buffered';
}

export function isAnswerCommitted(
  answerState: AgentTimelineAnswerState | undefined
): boolean {
  return answerState === undefined || answerState === 'committed';
}

export function isAnswerBusy(
  answerState: AgentTimelineAnswerState | undefined
): boolean {
  return answerState === 'streaming' || answerState === 'provisional';
}

export const AnswerSettlementStatus: React.FC<{
  answerState: AgentTimelineAnswerState | undefined;
  language: UiLanguage;
}> = ({ answerState, language }) => {
  if (
    answerState === undefined
    || answerState === 'streaming'
    || answerState === 'committed'
  ) {
    return null;
  }

  const messageKey = answerState === 'provisional'
    ? 'agent.answer.provisional'
    : answerState === 'stale'
      ? 'agent.answer.stale'
      : 'agent.answer.rejected';

  return (
    <div
      className={`agent-answer-settlement agent-answer-settlement--${answerState}`}
      role="status"
      aria-live="polite"
    >
      {t(language, messageKey)}
    </div>
  );
};
