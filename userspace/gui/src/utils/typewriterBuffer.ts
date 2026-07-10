export type BufferedTypewriterSpeed = 'slow' | 'normal' | 'fast';

export function bufferedTypewriterStep(backlog: number, speed: BufferedTypewriterSpeed): number {
  const base = speed === 'fast' ? 32 : speed === 'slow' ? 6 : 16;
  if (backlog <= 320) return base;
  const targetFrames = speed === 'fast' ? 14 : speed === 'slow' ? 42 : 24;
  return Math.min(4096, Math.max(base, Math.ceil(backlog / targetFrames)));
}

export function bufferedTypewriterDelay(speed: BufferedTypewriterSpeed): number {
  if (speed === 'fast') return 20;
  if (speed === 'slow') return 48;
  return 32;
}
