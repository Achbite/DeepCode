import type React from 'react';
import type { PanelSemanticSnapshot } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface PanelSnapshotCardProps {
  snapshot: PanelSemanticSnapshot | null;
  message?: string;
  attached?: boolean;
  language: UiLanguage;
}

const PanelSnapshotCard: React.FC<PanelSnapshotCardProps> = ({
  snapshot,
  message,
  attached = false,
  language,
}) => {
  if (!snapshot) {
    return (
      <section className="panel-snapshot-card panel-snapshot-card--empty">
        <div className="panel-snapshot-card__title">{t(language, 'browser.snapshotTitle')}</div>
        <p>{message ?? t(language, 'browser.message.snapshotCaptureUnavailable')}</p>
      </section>
    );
  }

  return (
    <section className="panel-snapshot-card">
      <div className="panel-snapshot-card__title">
        {snapshot.panelTitle ?? snapshot.selector}
        {attached && <span>{t(language, 'browser.attached')}</span>}
      </div>
      <dl>
        <div>
          <dt>URL</dt>
          <dd>{snapshot.url}</dd>
        </div>
        <div>
          <dt>{t(language, 'browser.selector')}</dt>
          <dd>{snapshot.selector}</dd>
        </div>
        {snapshot.textContent && (
          <div>
            <dt>{t(language, 'browser.text')}</dt>
            <dd>{snapshot.textContent}</dd>
          </div>
        )}
      </dl>
    </section>
  );
};

export default PanelSnapshotCard;
