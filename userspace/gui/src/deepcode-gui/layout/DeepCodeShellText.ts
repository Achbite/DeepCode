import { t, type UiLanguage } from '../../i18n';

export function statusLabel(language: UiLanguage, value: string): string {
  const translated = t(language, `deepcodeGui.status.${value}`);
  return translated.startsWith('deepcodeGui.status.') ? value : translated;
}

export function displaySessionTitle(language: UiLanguage, title?: string): string {
  const value = title?.trim();
  if (!value || value === 'New Agent Session' || value === '新 Agent 会话') {
    return t(language, 'agent.session.newTitle');
  }
  return value;
}

export function hasCustomSessionTitle(title?: string): boolean {
  const value = title?.trim();
  return Boolean(value && value !== 'New Agent Session' && value !== '新 Agent 会话');
}

export function shouldShowSidebarSession(session: { eventCount?: number; title?: string }): boolean {
  return (session.eventCount ?? 0) > 0 || hasCustomSessionTitle(session.title);
}
