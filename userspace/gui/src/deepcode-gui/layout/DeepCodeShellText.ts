import { t, type UiLanguage } from '../../i18n';

export function statusLabel(language: UiLanguage, value: string): string {
  const translated = t(language, `deepcodeGui.status.${value}`);
  return translated.startsWith('deepcodeGui.status.') ? value : translated;
}
