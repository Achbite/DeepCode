import React from 'react';
import { DEFAULT_USER_SETTINGS, type UserSettingValue } from '@deepcode/protocol';
import type { SettingDefinition, SettingSource } from '../../state/settingsStore';
import { t, type UiLanguage } from '../../i18n';

interface SettingsFieldProps {
  definition: SettingDefinition;
  value: UserSettingValue | undefined;
  source: SettingSource;
  language: UiLanguage;
  disabled?: boolean;
  onChange: (key: string, value: UserSettingValue) => void;
  onReset?: (key: string) => void;
}

function sourceLabel(source: SettingSource, language: UiLanguage): string {
  switch (source) {
    case 'workspace':
      return t(language, 'settings.source.workspace');
    case 'user':
      return t(language, 'settings.source.user');
    default:
      return t(language, 'settings.source.default');
  }
}

const SettingsField: React.FC<SettingsFieldProps> = ({
  definition,
  value,
  source,
  language,
  disabled = false,
  onChange,
  onReset,
}) => {
  const defaultValue = DEFAULT_USER_SETTINGS[definition.key];

  const renderControl = () => {
    if (definition.control === 'boolean') {
      return (
        <input
          className="settings-field__checkbox"
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(definition.key, event.target.checked)}
        />
      );
    }

    if (definition.control === 'number') {
      return (
        <input
          className="settings-field__input"
          type="number"
          value={typeof value === 'number' ? value : Number(value ?? defaultValue ?? 0)}
          disabled={disabled}
          onChange={(event) => onChange(definition.key, Number(event.target.value))}
        />
      );
    }

    if (definition.control === 'select') {
      return (
        <select
          className="settings-field__select"
          value={String(value ?? defaultValue ?? '')}
          disabled={disabled}
          onChange={(event) => onChange(definition.key, event.target.value)}
        >
          {(definition.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        className="settings-field__input"
        type="text"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(event) => onChange(definition.key, event.target.value)}
      />
    );
  };

  return (
    <div className="settings-field">
      <div className="settings-field__main">
        <div className="settings-field__title-row">
          <span className="settings-field__label">{definition.label}</span>
          <span className={`settings-field__source settings-field__source--${source}`}>
            {sourceLabel(source, language)}
          </span>
        </div>
        <div className="settings-field__key">{definition.key}</div>
        <div className="settings-field__description">{definition.description}</div>
        <div className="settings-field__default">
          {t(language, 'settings.defaultValuePrefix')}<code>{JSON.stringify(defaultValue)}</code>
        </div>
      </div>
      <div className="settings-field__control">
        {renderControl()}
        {onReset && source === 'user' && (
          <button
            className="settings-field__reset"
            type="button"
            disabled={disabled}
            onClick={() => onReset(definition.key)}
          >
            {t(language, 'settings.reset')}
          </button>
        )}
      </div>
    </div>
  );
};

export default SettingsField;
