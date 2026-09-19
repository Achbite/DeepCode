import { useEffect } from 'react';
import { normalizeUiLanguage, t } from '../i18n';
import { useSettingsStore } from '../state/settingsStore';
import { UI_FONT_FAMILY_SETTING, UI_FONT_SIZE_SETTING, uiFontFamily, uiFontSize } from './typography';

export default function GuiTypography() {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  let family: string | null = null;
  let scale: string | null = null;
  let error: string | null = null;
  try {
    family = uiFontFamily(settings[UI_FONT_FAMILY_SETTING]);
    scale = String(uiFontSize(settings[UI_FONT_SIZE_SETTING]) / 14);
  } catch (reason) { error = String(reason); }
  useEffect(() => {
    if (family === null || scale === null) return;
    const root = document.documentElement;
    root.style.setProperty('--dc-font-ui', family);
    root.style.setProperty('--dc-ui-font-scale', scale);
    return () => {
      root.style.removeProperty('--dc-font-ui');
      root.style.removeProperty('--dc-ui-font-scale');
    };
  }, [family, scale]);
  return error ? <div className="ui-palette-error" role="alert">
    {t(normalizeUiLanguage(settings['workbench.language']), 'settings.font.invalid')} {error}
  </div> : null;
}
