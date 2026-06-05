/**
 * Prompt Inspector 只读面板。
 *
 * 用户可编辑的生成约束只保留在 Ruler Settings；这里仅展示
 * Builtin System Prompt / Protocol Contract / 上下文拼装层的可审计 hash。
 */
import React, { useEffect, useState } from 'react';
import type { PromptLayer } from '@deepcode/protocol';
import { getAgentPromptLayers } from '../../../services/runtimeAdapter';
import { useSettingsStore } from '../../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../../i18n';

const PromptInspectorSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const [layers, setLayers] = useState<PromptLayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAgentPromptLayers()
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.data) {
          setLayers(result.data.layers);
          setMessage(null);
        } else {
          setMessage(result.message ?? result.error ?? 'prompt layers unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.prompt.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.prompt.inspector')}</h3>
        <p className="settings-card__body">{t(language, 'settings.prompt.body')}</p>
        <div className="settings-card__hint">{t(language, 'settings.prompt.readonly')}</div>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.prompt.layers')}</h3>
        {loading && <div className="settings-card__hint">{t(language, 'settings.common.loading')}</div>}
        {message && <div className="settings-card__hint">{message}</div>}
        {!loading && layers.length === 0 && (
          <div className="settings-card__hint">{t(language, 'settings.prompt.empty')}</div>
        )}
        <div className="settings-list-editor">
          {layers.map((layer) => (
            <div className="prompt-layer-row" key={layer.id}>
              <div className="prompt-layer-row__meta">
                <span className="settings-pill">{layer.kind}</span>
                <strong>{layer.title ?? layer.id}</strong>
                <span>{t(language, 'settings.prompt.priority', { priority: layer.priority })}</span>
              </div>
              <div className="settings-card__hint">
                {layer.path ? `${layer.path} · ` : ''}
                {layer.contentHash}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PromptInspectorSection;
