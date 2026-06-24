import React from 'react';
import DiffView, { computeDiffStats } from './DiffView';
import type { DiffFile } from './cardModel';

/**
 * DiffCard：多文件变更的聚合差异卡（B1 §12.3，对标 Kun TurnChangeSummary）。
 *
 * - 头部展示文件数与聚合 +added/-removed 统计。
 * - 逐文件可展开，展开后内嵌 DiffView 渲染内联差异；折叠时不挂载重体 DiffView。
 * - 纯展示：消费已组装好的 DiffFile[]，不调用 Kernel、不裁决。
 */

interface DiffCardProps {
  files: DiffFile[];
  label?: string;
  defaultOpen?: boolean;
  truncatedSuffix?: string;
}

const DiffCard: React.FC<DiffCardProps> = ({ files, label, defaultOpen = false, truncatedSuffix }) => {
  const perFileStats = React.useMemo(
    () => files.map((file) => computeDiffStats(file.patch)),
    [files],
  );
  const totals = React.useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const stat of perFileStats) {
      added += stat.added;
      removed += stat.removed;
    }
    return { added, removed };
  }, [perFileStats]);

  const [openPaths, setOpenPaths] = React.useState<Set<string>>(() =>
    defaultOpen && files[0] ? new Set([files[0].path]) : new Set(),
  );

  if (files.length === 0) return null;

  const toggle = (path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="agent-diff-card">
      <div className="agent-diff-card__header">
        <span className="agent-diff-card__label">
          {label ? `${label} · ` : ''}
          {files.length}
        </span>
        <span className="agent-diff-card__stat">
          <span className="agent-diff-view__stat-added">+{totals.added}</span>
          <span className="agent-diff-view__stat-removed">-{totals.removed}</span>
        </span>
      </div>
      <div className="agent-diff-card__files">
        {files.map((file, index) => {
          const open = openPaths.has(file.path);
          const stat = perFileStats[index];
          return (
            <div key={`${file.path}-${index}`} className="agent-diff-card__file">
              <button
                type="button"
                className="agent-diff-card__file-head"
                aria-expanded={open}
                onClick={() => toggle(file.path)}
              >
                <span className="agent-diff-card__file-chevron">{open ? '▾' : '▸'}</span>
                <span className="agent-diff-card__file-path" title={file.path}>
                  {file.path}
                  {file.truncated && truncatedSuffix ? truncatedSuffix : ''}
                </span>
                <span className="agent-diff-card__file-stat">
                  <span className="agent-diff-view__stat-added">+{stat.added}</span>
                  <span className="agent-diff-view__stat-removed">-{stat.removed}</span>
                </span>
              </button>
              {open && (
                <div className="agent-diff-card__file-body">
                  <DiffView patch={file.patch} maxHeight={320} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DiffCard;
