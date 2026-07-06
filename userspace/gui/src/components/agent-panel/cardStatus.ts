

export type CardStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed';


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

export function cardStatusIsSpinning(status: CardStatus): boolean {
  return status === 'running';
}

export function cardStatusDefaultOpen(status: CardStatus): boolean {
  return status === 'running' || status === 'failed' || status === 'blocked' || status === 'waiting';
}

export function cardStatusClass(status: CardStatus): string {
  return `is-${status}`;
}
