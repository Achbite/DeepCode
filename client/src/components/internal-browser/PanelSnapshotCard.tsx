import type React from 'react';
import type { PanelSemanticSnapshot } from '@deepcode/protocol';

interface PanelSnapshotCardProps {
  snapshot: PanelSemanticSnapshot | null;
  message?: string;
  attached?: boolean;
}

const PanelSnapshotCard: React.FC<PanelSnapshotCardProps> = ({
  snapshot,
  message,
  attached = false,
}) => {
  if (!snapshot) {
    return (
      <section className="panel-snapshot-card panel-snapshot-card--empty">
        <div className="panel-snapshot-card__title">Panel Snapshot</div>
        <p>{message ?? 'Panel snapshot capture is reserved but not implemented yet.'}</p>
      </section>
    );
  }

  return (
    <section className="panel-snapshot-card">
      <div className="panel-snapshot-card__title">
        {snapshot.panelTitle ?? snapshot.selector}
        {attached && <span>Attached</span>}
      </div>
      <dl>
        <div>
          <dt>URL</dt>
          <dd>{snapshot.url}</dd>
        </div>
        <div>
          <dt>Selector</dt>
          <dd>{snapshot.selector}</dd>
        </div>
        {snapshot.textContent && (
          <div>
            <dt>Text</dt>
            <dd>{snapshot.textContent}</dd>
          </div>
        )}
      </dl>
    </section>
  );
};

export default PanelSnapshotCard;
