import type React from 'react';
import type { PanelSemanticSnapshot } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface PanelSnapshotCardProps {
  snapshot: PanelSemanticSnapshot | null;
  message?: string;
  attached?: boolean;
  language: UiLanguage;
}

function boundingRectText(snapshot: PanelSemanticSnapshot): string | null {
  if (!snapshot.boundingRect) return null;
  const { x, y, width, height } = snapshot.boundingRect;
  return `x:${x} y:${y} w:${width} h:${height}`;
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
          <dt>{t(language, 'browser.url')}</dt>
          <dd>{snapshot.url}</dd>
        </div>
        <div>
          <dt>{t(language, 'browser.capturedAt')}</dt>
          <dd>{snapshot.capturedAt}</dd>
        </div>
        <div>
          <dt>{t(language, 'browser.selector')}</dt>
          <dd>{snapshot.selector}</dd>
        </div>
        {snapshot.panelKind && (
          <div>
            <dt>{t(language, 'browser.panelKind')}</dt>
            <dd>{snapshot.panelKind}</dd>
          </div>
        )}
        {boundingRectText(snapshot) && (
          <div>
            <dt>{t(language, 'browser.boundingRect')}</dt>
            <dd>{boundingRectText(snapshot)}</dd>
          </div>
        )}
        {snapshot.textContent && (
          <div>
            <dt>{t(language, 'browser.text')}</dt>
            <dd>{snapshot.textContent}</dd>
          </div>
        )}
        {snapshot.sourceHints && snapshot.sourceHints.length > 0 && (
          <div>
            <dt>{t(language, 'browser.sourceHints')}</dt>
            <dd>{snapshot.sourceHints.join(', ')}</dd>
          </div>
        )}
        {snapshot.relatedFiles && snapshot.relatedFiles.length > 0 && (
          <div>
            <dt>{t(language, 'browser.relatedFiles')}</dt>
            <dd>{snapshot.relatedFiles.join(', ')}</dd>
          </div>
        )}
      </dl>
    </section>
  );
};

export default PanelSnapshotCard;
