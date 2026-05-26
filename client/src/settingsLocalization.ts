import { settingText, type UiLanguage } from './i18n';
import type { SettingDefinition } from './state/settingsStore';

export function localizeSettingDefinition(
  definition: SettingDefinition,
  language: UiLanguage
): SettingDefinition {
  const text = settingText(language, definition.key);
  if (!text) return definition;
  return {
    ...definition,
    label: text.label ?? definition.label,
    description: text.description ?? definition.description,
    options: definition.options?.map((option) => ({
      ...option,
      label: text.options?.[option.value] ?? option.label,
    })),
  };
}
