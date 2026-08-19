export type BufferedTypewriterSpeed = 'slow' | 'normal' | 'fast';

interface BufferedTypewriterProfile {
  baseStep: number;
  maxStep: number;
  backlogDivisor: number;
  intervalMs: number;
}

const TYPEWRITER_PROFILES: Record<BufferedTypewriterSpeed, BufferedTypewriterProfile> = {
  slow: { baseStep: 2, maxStep: 32, backlogDivisor: 20, intervalMs: 48 },
  normal: { baseStep: 4, maxStep: 96, backlogDivisor: 12, intervalMs: 32 },
  fast: { baseStep: 8, maxStep: 192, backlogDivisor: 8, intervalMs: 16 },
};

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function bufferedTypewriterStep(backlog: number, speed: BufferedTypewriterSpeed): number {
  if (backlog <= 0) return 0;
  const profile = TYPEWRITER_PROFILES[speed];
  return Math.min(
    profile.maxStep,
    Math.max(profile.baseStep, Math.ceil(backlog / profile.backlogDivisor))
  );
}

export function bufferedTypewriterDelay(speed: BufferedTypewriterSpeed): number {
  return TYPEWRITER_PROFILES[speed].intervalMs;
}

export function bufferedTypewriterNextIndex(
  text: string,
  currentIndex: number,
  speed: BufferedTypewriterSpeed
): number {
  const start = Math.max(0, Math.min(text.length, currentIndex));
  if (start >= text.length) return text.length;

  const step = bufferedTypewriterStep(text.length - start, speed);
  if (graphemeSegmenter) {
    let consumed = 0;
    let nextIndex = start;
    for (const segment of graphemeSegmenter.segment(text)) {
      const segmentEnd = segment.index + segment.segment.length;
      if (segmentEnd <= start) continue;
      nextIndex = segmentEnd;
      consumed += 1;
      if (consumed >= step) return nextIndex;
    }
    return text.length;
  }

  const nextText = Array.from(text.slice(start)).slice(0, step).join('');
  return Math.min(text.length, start + nextText.length);
}
