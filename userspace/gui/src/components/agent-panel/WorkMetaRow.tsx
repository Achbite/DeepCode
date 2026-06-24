import React from 'react';
import { formatDurationMs } from '../../utils/toolEvidence';

/**
 * WorkMetaRow：turn 级"处理过程"摘要行（B1 §12，对标 Kun WorkMetaRow）。
 *
 * 以极简形态展示本轮操作步数与耗时，不抢占消息区视觉；纯展示，不依赖翻译文案。
 */

interface WorkMetaRowProps {
  stepCount: number;
  durationMs?: number;
}

const WorkMetaRow: React.FC<WorkMetaRowProps> = ({ stepCount, durationMs }) => {
  if (stepCount <= 0 && !durationMs) return null;
  const duration = formatDurationMs(durationMs);
  return (
    <span className="agent-work-meta" aria-hidden={false}>
      <span className="agent-work-meta__glyph">⚙</span>
      {stepCount > 0 && <span className="agent-work-meta__steps">{stepCount}</span>}
      {duration && (
        <>
          <span className="agent-work-meta__dot">·</span>
          <span className="agent-work-meta__duration">{duration}</span>
        </>
      )}
    </span>
  );
};

export default WorkMetaRow;
