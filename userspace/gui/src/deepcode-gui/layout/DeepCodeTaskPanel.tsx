import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import { statusLabel } from './DeepCodeShellText';

export interface DeepCodeTaskItem {
  id: string;
  title: string;
  summary: string;
  status: string;
}

interface DeepCodeTaskPanelProps {
  language: UiLanguage;
  items: DeepCodeTaskItem[];
}

const DeepCodeTaskPanel: React.FC<DeepCodeTaskPanelProps> = ({ language, items }) => (
  <aside className="deepcode-gui-context-panel">
    <section className="deepcode-gui-task-list-card">
      <div className="deepcode-gui-task-list-card__title">{t(language, 'deepcodeGui.tasks.title')}</div>
      {items.length === 0 ? (
        <div className="deepcode-gui-task-list-card__empty">{t(language, 'deepcodeGui.tasks.empty')}</div>
      ) : (
        <div className="deepcode-gui-task-list">
          {items.map((item) => (
            <div key={item.id} className={`deepcode-gui-task-item deepcode-gui-task-item--${item.status}`}>
              <span className="deepcode-gui-task-item__dot" />
              <div>
                <div className="deepcode-gui-task-item__title">{item.title}</div>
                <div className="deepcode-gui-task-item__summary">{item.summary}</div>
              </div>
              <strong>{statusLabel(language, item.status)}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  </aside>
);

export default DeepCodeTaskPanel;
