import AppearanceConfiguration from './AppearanceConfiguration';
import { PALETTE_SETTING, decodePaletteOverrides, paletteToken } from '../../theme/palette';
import GuiPaletteSettings from './GuiPaletteSettings';
import { useSettingsSearchTarget } from './settingsSearch';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { useSettingsHelp } from './SettingsHelp';
import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import {
  useSettingsStore,
  type SettingDefinition,
  type SettingSource,
} from '../../state/settingsStore';
import {
  GUI_ACCENT_COLORS,
  GUI_THEME_PREFERENCES,
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
  type GuiAccentColor,
  type GuiThemePreference,
} from '../../theme/deepcodeGuiTheme';


interface GuiAppearanceSettingsProps {
  definitions: SettingDefinition[];
  language: UiLanguage;
}


function sourceLabel(source: SettingSource, language: UiLanguage): string {
  switch (source) {
    case 'user':
      return t(language, 'settings.source.user');
    default:
      return t(language, 'settings.source.default');
  }
}

function optionLabel(definition: SettingDefinition, value: string): string {
  return definition.options?.find((option) => option.value === value)?.label ?? value;
}

interface AppearanceSettingHeaderProps {
  definition: SettingDefinition;
  source: SettingSource;
  language: UiLanguage;
  disabled: boolean;
  onReset: () => void;
}

const AppearanceSettingHeader: React.FC<AppearanceSettingHeaderProps> = ({
  definition,
  source,
  language,
  disabled,
  onReset,
}) => {
  const target = useSettingsSearchTarget(definition.key);
  const { helpId, helpEvents, help } = useSettingsHelp(definition.description);
  return (
  <div ref={target} tabIndex={-1} aria-describedby={helpId} {...helpEvents} className="settings-appearance__header">
    {help}
    <div>
      <div className="settings-field__title-row">
        <span className="settings-field__label">{definition.label}</span>
        <span className={`settings-field__source settings-field__source--${source}`}>
          {sourceLabel(source, language)}
        </span>
      </div>

    </div>
    {source === 'user' && (
      <button
        className="settings-field__reset"
        type="button"
        disabled={disabled}
        onClick={onReset}
      >
        {t(language, 'settings.reset')}
      </button>
    )}
  </div>
);
};

const GuiAppearanceSettings: React.FC<GuiAppearanceSettingsProps> = ({
  definitions,
  language,
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const patchUserSettingsBatch = useSettingsStore((state) => state.patchUserSettingsBatch);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const themeDefinition = definitions.find((definition) => definition.key === 'gui.colorTheme');
  const accentDefinition = definitions.find((definition) => definition.key === 'gui.accentColor');
  const theme = normalizeGuiThemePreference(effectiveSettings['gui.colorTheme']);
  const accent = normalizeGuiAccentColor(effectiveSettings['gui.accentColor']);
  const themeSource = themeDefinition ? sources[themeDefinition.key] ?? 'default' : 'default';
  const accentSource = accentDefinition ? sources[accentDefinition.key] ?? 'default' : 'default';
  const themeDisabled = loading;
  const accentDisabled = loading;
  if (!themeDefinition && !accentDefinition) return null;

  const selectTheme = (value: GuiThemePreference, disabled: boolean) => {
    if (!disabled && value !== theme) void patchUserSetting('gui.colorTheme', value);
  };
  const selectAccent = (value: GuiAccentColor, disabled: boolean) => {
    if (disabled) return;
    try {
      const colors = decodePaletteOverrides(String(effectiveSettings[PALETTE_SETTING] ?? '{}'));
      delete colors[paletteToken('light', 'accent')];
      delete colors[paletteToken('dark', 'accent')];
      void patchUserSettingsBatch({ 'gui.accentColor': value, [PALETTE_SETTING]: JSON.stringify(colors) });
    } catch (reason) {
      useSettingsStore.setState({ errorMessage: String(reason) });
    }
  };

  return (
    <>
    <AppearanceConfiguration language={language} />
    <div className="settings-card settings-appearance">
      <h3 className="settings-card__title">{t(language, 'settings.gui.appearance')}</h3>
      <div className="settings-appearance__body">
        {themeDefinition && (
          <section className="settings-appearance__setting">
            <AppearanceSettingHeader
              definition={themeDefinition}
              source={themeSource}
              language={language}
              disabled={themeDisabled}
              onReset={() => void resetUserSetting(themeDefinition.key)}
            />
            <div
              className="settings-theme-grid"
              role="group"
              aria-label={themeDefinition.label}
            >
              {GUI_THEME_PREFERENCES.map((value) => (
                <button
                  className="settings-theme-card"
                  type="button"
                  data-theme-choice={value}
                  aria-pressed={theme === value}
                  disabled={themeDisabled}
                  key={value}
                  onClick={() => selectTheme(value, themeDisabled)}
                >
                  <span className="settings-theme-preview" aria-hidden="true" />
                  <span className="settings-theme-label">
                    <span className="settings-selection-check" aria-hidden="true"><DeepCodeShellIcon name="check" size={14} /></span>
                    {optionLabel(themeDefinition, value)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <GuiPaletteSettings language={language} />
        {accentDefinition && (
        <section className="settings-appearance__setting">
            <AppearanceSettingHeader
              definition={accentDefinition}
              source={accentSource}
              language={language}
              disabled={accentDisabled}
              onReset={() => void resetUserSetting(accentDefinition.key)}
            />
            <div
              className="settings-accent-options"
              role="group"
              aria-label={accentDefinition.label}
            >
              {GUI_ACCENT_COLORS.map((value) => (
                <button
                  className="settings-accent-option"
                  type="button"
                  aria-pressed={accent === value}
                  disabled={accentDisabled}
                  key={value}
                  onClick={() => selectAccent(value, accentDisabled)}
                >
                  <span
                    className={`settings-accent-swatch settings-accent-swatch--${value}`}
                    aria-hidden="true"
                  />
                  <span>{optionLabel(accentDefinition, value)}</span>
                  <span className="settings-accent-check" aria-hidden="true"><DeepCodeShellIcon name="check" size={14} /></span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
    </>
  );
};

export default GuiAppearanceSettings;
