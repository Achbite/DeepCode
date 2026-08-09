import React from 'react';
import type {
  AgentTimelineResourcePresentation,
  AgentTimelineTaskOutcome,
  AgentTimelineTaskProgress,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

export interface DeepCodeTaskItem {
  id: string;
  blockId: string;
  title: string;
  summary: string;
  progress: AgentTimelineTaskProgress;
  outcome: AgentTimelineTaskOutcome | null;
  targetRefs: string[];
  resourcePresentation: AgentTimelineResourcePresentation[];
}

interface DeepCodeTaskPanelProps {
  language: UiLanguage;
  items: DeepCodeTaskItem[];
}

function structuredTargetLabel(item: DeepCodeTaskItem): string {
  const labels = item.resourcePresentation.flatMap((resource) => {
    const label = resource.kind === 'workspacePath'
      ? resource.workspaceRelativePath ?? resource.label
      : resource.label;
    const normalized = label.trim();
    return normalized ? [normalized] : [];
  });
  return [...new Set(labels)].join(' · ');
}

const DeepCodeTaskPanel: React.FC<DeepCodeTaskPanelProps> = ({ language, items }) => (
  <aside className="deepcode-gui-context-panel">
    <section className="deepcode-gui-task-list-card">
      <div className="deepcode-gui-task-list-card__title">{t(language, 'deepcodeGui.tasks.title')}</div>
      {items.length === 0 ? (
        <div className="deepcode-gui-task-list-card__empty">{t(language, 'deepcodeGui.tasks.empty')}</div>
      ) : (
        <div className="deepcode-gui-task-list">
          {items.map((item) => {
            const targetLabel = structuredTargetLabel(item);
            const statusSummary = item.summary
              || t(language, `deepcodeGui.tasks.progress.${item.progress}`);
            return (
              <div
                key={JSON.stringify([item.id, item.targetRefs])}
                className={`deepcode-gui-task-item deepcode-gui-task-item--${item.progress}`}
              >
                <span className="deepcode-gui-task-item__dot" />
                <div>
                  <div className="deepcode-gui-task-item__title">{item.title}</div>
                  {targetLabel && (
                    <div className="deepcode-gui-task-item__summary">{targetLabel}</div>
                  )}
                </div>
                <strong>{statusSummary}</strong>
              </div>
            );
          })}
        </div>
      )}
    </section>
  </aside>
);

export default DeepCodeTaskPanel;
