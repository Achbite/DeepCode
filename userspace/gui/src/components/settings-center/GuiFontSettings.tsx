import React, { useEffect, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { UI_FONT_FAMILY_SETTING, UI_FONT_SIZE_SETTING, UI_FONT_PRESETS, uiFontFamily, uiFontSize } from '../../theme/typography';
import { useSettingsSearchEntries, useSettingsSearchTarget } from './settingsSearch';
import { reconcileSettingDraft } from './settingDraft';

export default function GuiFontSettings({ language }: { language: UiLanguage }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const saved = JSON.stringify([settings[UI_FONT_FAMILY_SETTING] ?? 'system', settings[UI_FONT_SIZE_SETTING] ?? 14]);
  const [draft, setDraft] = useState({ saved, text: saved });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => setDraft((current) => reconcileSettingDraft(current, saved)), [saved]);
  const [family, size] = JSON.parse(draft.text) as [string, number];
  const preset = !custom && Object.hasOwn(UI_FONT_PRESETS, family) ? family : 'custom';
  const target = useSettingsSearchTarget(UI_FONT_FAMILY_SETTING);
  useSettingsSearchEntries('ui-font', [{ id: UI_FONT_FAMILY_SETTING, category: 'gui', title: t(language, 'settings.font.title'), keywords: 'UI 字体 字号 font family size typography' }]);
  const edit = (nextFamily: string, nextSize: number) => { setDraft((current) => ({ ...current, text: JSON.stringify([nextFamily, nextSize]) })); setError(null); };
  let preview: string | undefined;
  try { preview = uiFontFamily(family); } catch { /* Keep the draft editable; Save reports validation. */ }
  const save = async (reset = false) => {
    setSaving(true); setError(null);
    try {
      if (!reset) { uiFontFamily(family); uiFontSize(size); }
      const state = useSettingsStore.getState();
      const result = await state.patchUserSettingsBatch({
        [UI_FONT_FAMILY_SETTING]: reset ? null : family,
        [UI_FONT_SIZE_SETTING]: reset ? null : size,
      });
      if (result === null) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.edit.failed'));
      const canonical = useSettingsStore.getState().effectiveSettings;
      const text = JSON.stringify([canonical[UI_FONT_FAMILY_SETTING] ?? 'system', canonical[UI_FONT_SIZE_SETTING] ?? 14]);
      setDraft({ saved: text, text });
      setCustom(false);
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return <section ref={target} tabIndex={-1} className="settings-card appearance-config-box" aria-labelledby="ui-font-heading">
    <h3 id="ui-font-heading" className="settings-card__title">{t(language, 'settings.font.title')}</h3>
    <div className="appearance-config-box__body">
      <div className="appearance-font-controls">
        <label>{t(language, 'settings.font.family')}
          <select value={preset} disabled={loading || saving} onChange={(event) => {
            const next = event.target.value;
            setCustom(next === 'custom');
            if (next !== 'custom') edit(next, size);
          }}>
            {[...Object.keys(UI_FONT_PRESETS), 'custom'].map((value) => <option key={value} value={value}>{t(language, `settings.font.${value}`)}</option>)}
          </select>
        </label>
        <label>{t(language, 'settings.font.size')}
          <select value={size} disabled={loading || saving} onChange={(event) => edit(family, Number(event.target.value))}>
            {[12, 13, 14, 15, 16, 17, 18].map((value) => <option key={value} value={value}>{value} px</option>)}
          </select>
        </label>
      </div>
      {preset === 'custom' && <label>{t(language, 'settings.font.customName')}
        <input value={Object.hasOwn(UI_FONT_PRESETS, family) ? '' : family} placeholder="PingFang SC" disabled={loading || saving}
          onChange={(event) => edit(event.target.value, size)} />
      </label>}
      <div className="appearance-font-preview" style={{ fontFamily: preview, fontSize: Number.isFinite(size) ? size : undefined }}>
        <strong>DeepCode Aa</strong><span>{t(language, 'settings.font.preview')}</span>
      </div>
      <div className="appearance-config-box__actions">
        <button type="button" className="settings-button" disabled={loading || saving} onClick={() => void save(true)}>{t(language, 'settings.reset')}</button>
        <button type="button" className="settings-button settings-button--primary" disabled={loading || saving || draft.text === saved || !preview}
          onClick={() => void save()}>{t(language, saving ? 'settings.edit.saving' : 'settings.edit.save')}</button>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </section>;
}
