import { normalizeUiLanguage } from './i18n';
import { useSettingsStore } from './state/settingsStore';
export function useUiLanguage() { return normalizeUiLanguage(useSettingsStore((state) => state.effectiveSettings['workbench.language'])); }
