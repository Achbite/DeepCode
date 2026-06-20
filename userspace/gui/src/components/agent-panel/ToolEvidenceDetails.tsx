import React from 'react';
import type { UiLanguage } from '../../i18n';
import type { ToolEvidenceSummary } from '../../utils/toolEvidence';
import { formatDurationMs } from '../../utils/toolEvidence';

interface ToolEvidenceDetailsProps {
  evidence: ToolEvidenceSummary;
  language: UiLanguage;
  maxItems?: number;
}

const ToolEvidenceDetails: React.FC<ToolEvidenceDetailsProps> = ({
  evidence,
  language,
  maxItems = 24,
}) => {
  if (evidence.items.length === 0) return null;
  const visibleItems = evidence.items.slice(0, maxItems);
  const hiddenCount = Math.max(0, evidence.items.length - visibleItems.length);

  return (
    <div className="agent-evidence-list">
      {visibleItems.map((item) => (
        <div
          key={item.id}
          className={`agent-evidence-item agent-evidence-item--${item.kind} agent-evidence-item--${item.status}`}
        >
          <span className="agent-evidence-item__verb">{item.action}</span>
          <span className="agent-evidence-item__label" title={item.label}>
            {item.label}
          </span>
          {item.detail && <span className="agent-evidence-item__detail">{item.detail}</span>}
          {item.kind === 'command' && (
            <div className="agent-evidence-item__meta">
              {typeof item.exitCode === 'number' && (
                <span>{language === 'zh-CN' ? `退出码 ${item.exitCode}` : `exit ${item.exitCode}`}</span>
              )}
              {item.cwd && <span>{language === 'zh-CN' ? `目录 ${item.cwd}` : `cwd ${item.cwd}`}</span>}
              {formatDurationMs(item.durationMs) && <span>{formatDurationMs(item.durationMs)}</span>}
              {item.truncated && <span>{language === 'zh-CN' ? '已截断' : 'truncated'}</span>}
            </div>
          )}
          {(item.stdout || item.stderr || item.error) && (
            <details className="agent-evidence-output">
              <summary>{language === 'zh-CN' ? '输出' : 'Output'}</summary>
              {item.stdout && <pre>{item.stdout}</pre>}
              {item.stderr && <pre>{item.stderr}</pre>}
              {item.error && <pre>{item.error}</pre>}
            </details>
          )}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="agent-evidence-list__more">
          {language === 'zh-CN' ? `另有 ${hiddenCount} 项` : `+${hiddenCount} more`}
        </div>
      )}
    </div>
  );
};

export default ToolEvidenceDetails;
