/**
 * cardStatus：GUI 卡片统一状态语义与视觉映射。
 *
 * 收敛此前碎片化的状态枚举（ToolEvidenceStatus / batch status / CSS --${status}），
 * 对齐 protocol 的 AgentTimelineStatus，提供归一化与统一的 icon glyph / 配色 class，
 * 供 ToolCard / DiffCard / ReviewCard 等卡片复用。
 *
 * 纯展示工具：不调用 Kernel、不裁决、不改事实。
 */

export type CardStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed';

// ---- 把任意来源的状态字符串归一为 CardStatus ----
export function normalizeCardStatus(raw: string | undefined | null, fallback: CardStatus = 'completed'): CardStatus {
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  switch (value) {
    case 'ok':
    case 'done':
    case 'success':
    case 'succeeded':
    case 'completed':
    case 'accept':
    case 'accepted':
    case 'allow':
    case 'allowed':
      return 'completed';
    case 'error':
    case 'failed':
    case 'failure':
    case 'denied':
    case 'deny':
    case 'reject':
    case 'rejected':
    case 'aborted':
      return 'failed';
    case 'running':
    case 'started':
    case 'in_progress':
    case 'inprogress':
    case 'executing':
      return 'running';
    case 'waiting':
    case 'pending':
    case 'ask':
    case 'awaitinguserapproval':
    case 'awaitinguserreview':
    case 'waitinguserconfirmation':
    case 'waitinguserreview':
      return 'waiting';
    case 'blocked':
    case 'needsreplan':
    case 'needsuserreview':
    case 'needsrevision':
      return 'blocked';
    case 'queued':
      return 'queued';
    default:
      return fallback;
  }
}

// ---- 状态对应的 unicode 字形（running 由 CSS spinner 呈现，这里返回空串） ----
export function cardStatusGlyph(status: CardStatus): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✕';
    case 'waiting':
      return '⏳';
    case 'blocked':
      return '⊘';
    case 'queued':
      return '·';
    case 'running':
    default:
      return '';
  }
}

// ---- 是否用 spinner 表示进行中 ----
export function cardStatusIsSpinning(status: CardStatus): boolean {
  return status === 'running';
}

// ---- 卡片默认是否展开：进行中/失败/阻塞默认展开，成功/排队默认折叠（对标 Kun 语义） ----
export function cardStatusDefaultOpen(status: CardStatus): boolean {
  return status === 'running' || status === 'failed' || status === 'blocked' || status === 'waiting';
}

// ---- CSS 修饰类后缀 ----
export function cardStatusClass(status: CardStatus): string {
  return `is-${status}`;
}
