import { t, type UiLanguage } from '../../i18n';

export function formatBytes(value: number, language: UiLanguage): string {
  if (value < 1024) {
    return t(language, 'agent.attachment.size.bytes', {
      value: value.toLocaleString(language),
    });
  }
  return t(language, 'agent.attachment.size.kibibytes', {
    value: Math.ceil(value / 1024).toLocaleString(language),
  });
}
