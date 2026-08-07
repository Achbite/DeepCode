import React from 'react';
import type { AgentTimelineTaskProgress } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

export interface DeepCodeTaskItem {
  id: string;
  title: string;
  summary: string;
  progress: AgentTimelineTaskProgress;
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
            <div key={item.id} className={`deepcode-gui-task-item deepcode-gui-task-item--${item.progress}`}>
              <span className="deepcode-gui-task-item__dot" />
              <div>
                <div className="deepcode-gui-task-item__title">{item.title}</div>
              </div>
              <strong>{t(language, `deepcodeGui.tasks.progress.${item.progress}`)}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  </aside>
);

export default DeepCodeTaskPanel;
