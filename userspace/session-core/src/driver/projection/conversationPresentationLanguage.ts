import type { AgentEvent, ConversationLanguage } from '@deepcode/protocol';
import {
  effectiveConversationLanguage,
  resolveConversationLanguagePolicy,
} from '../context/conversationLanguagePolicy.js';
import { latestSessionTurnAuthority } from '../context/userAuthorityFrame.js';

export type ConversationPresentationLanguage = ConversationLanguage | 'neutral';
export type ProjectionLanguageBindingStatus =
  | 'pending'
  | 'resolved'
  | 'fallback'
  | 'superseded'
  | 'unavailable';

export interface ProjectionLanguageBinding {
  readonly language: ConversationPresentationLanguage;
  readonly revision?: number;
  readonly status: ProjectionLanguageBindingStatus;
  readonly sourceTurnId?: string;
}

export interface ConversationPresentationLanguageState {
  userAuthorityFrame?: {
    effectiveLanguage?: ConversationLanguage;
    languagePolicy?: {
      status?: string;
      revision?: number;
      sourceTurnId?: string;
    };
  };
}

export function conversationPresentationLanguage(
  state: ConversationPresentationLanguageState
): ConversationPresentationLanguage {
  return conversationPresentationLanguageBinding(state).language;
}

export function conversationPresentationLanguageBinding(
  state: ConversationPresentationLanguageState
): ProjectionLanguageBinding {
  const status = state.userAuthorityFrame?.languagePolicy?.status;
  const normalizedStatus = status === 'pending'
    || status === 'resolved'
    || status === 'fallback'
    || status === 'superseded'
    ? status
    : 'unavailable';
  return {
    language: normalizedStatus === 'resolved' || normalizedStatus === 'fallback'
      ? state.userAuthorityFrame?.effectiveLanguage ?? 'neutral'
      : 'neutral',
    revision: state.userAuthorityFrame?.languagePolicy?.revision,
    status: normalizedStatus,
    sourceTurnId: state.userAuthorityFrame?.languagePolicy?.sourceTurnId,
  };
}

export function conversationPresentationLanguageFromEvents(
  events: readonly AgentEvent[],
  runId?: string
): ConversationPresentationLanguage {
  return conversationPresentationLanguageBindingFromEvents(events, runId).language;
}

export function conversationPresentationLanguageBindingFromEvents(
  events: readonly AgentEvent[],
  runId?: string
): ProjectionLanguageBinding {
  const authority = latestSessionTurnAuthority(events, runId);
  if (!authority) {
    return {
      language: 'neutral',
      status: 'unavailable',
    };
  }
  const policy = resolveConversationLanguagePolicy(events, authority);
  return {
    language: policy.status === 'resolved' || policy.status === 'fallback'
      ? effectiveConversationLanguage(policy)
      : 'neutral',
    revision: policy.revision,
    status: policy.status,
    sourceTurnId: authority.turnId,
  };
}

export function localizedProjectionText(
  language: ConversationPresentationLanguage,
  values: {
    zh: string;
    en: string;
    neutral: string;
  }
): string {
  if (language === 'zh-CN') return values.zh;
  if (language === 'en-US') return values.en;
  return values.neutral;
}
