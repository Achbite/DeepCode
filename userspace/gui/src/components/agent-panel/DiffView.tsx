import React from 'react';

/**
 * DiffView：把一段 unified diff 文本渲染为面向人类可读的内联差异视图。
 *
 * 设计取舍（对标 Kun message-timeline-cards 的 DiffView + codex diff_render）：
 *   - 仅做"文本 -> 行分类 -> 着色渲染"的纯展示，不解析语义、不调用 Kernel、不裁决。
 *   - 行类型：meta（文件头/index）、hunk（@@ 段）、added（+）、removed（-）、context（普通）。
 *   - 大体量 diff 用 contentVisibility 让浏览器跳过视口外渲染，缓解长输出卡顿。
 *   - 不依赖第三方 diff 库，避免给 Host 引入额外依赖。
 */

export interface DiffStats {
  added: number;
  removed: number;
}

type DiffLineKind = 'meta' | 'hunk' | 'added' | 'removed' | 'context';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

interface DiffViewProps {
  patch: string;
  filePath?: string;
  /** 内容区最大高度，超出滚动；单位 px。 */
  maxHeight?: number;
  className?: string;
}

// ---- 单行分类 ----
function classifyLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('\\ No newline')
  ) {
    return 'meta';
  }
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

// ---- 解析 unified diff 为行序列 ----
function parsePatch(patch: string): DiffLine[] {
  const normalized = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.split('\n').map((text) => ({ kind: classifyLine(text), text }));
}

// ---- 统计新增/删除行数（不含文件头与 hunk 头） ----
export function computeDiffStats(patch: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const { kind } of parsePatch(patch)) {
    if (kind === 'added') added += 1;
    else if (kind === 'removed') removed += 1;
  }
  return { added, removed };
}

const DiffView: React.FC<DiffViewProps> = ({ patch, filePath, maxHeight = 360, className }) => {
  const lines = React.useMemo(() => parsePatch(patch), [patch]);
  const stats = React.useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const { kind } of lines) {
      if (kind === 'added') added += 1;
      else if (kind === 'removed') removed += 1;
    }
    return { added, removed };
  }, [lines]);

  return (
    <div className={`agent-diff-view${className ? ` ${className}` : ''}`}>
      {(filePath || stats.added > 0 || stats.removed > 0) && (
        <div className="agent-diff-view__bar">
          {filePath && (
            <span className="agent-diff-view__path" title={filePath}>
              {filePath}
            </span>
          )}
          <span className="agent-diff-view__stat">
            <span className="agent-diff-view__stat-added">+{stats.added}</span>
            <span className="agent-diff-view__stat-removed">-{stats.removed}</span>
          </span>
        </div>
      )}
      <div
        className="agent-diff-view__body"
        style={{ maxHeight, contentVisibility: 'auto', containIntrinsicSize: 'auto 240px' }}
      >
        {lines.map((line, index) => (
          <div key={index} className={`agent-diff-line agent-diff-line--${line.kind}`}>
            <span className="agent-diff-line__text">{line.text || '\u00a0'}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DiffView;
