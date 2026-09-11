import { calculateChangedLines } from './fileChangeLineCounts';

self.onmessage = ({ data }: MessageEvent<{ before: string | null; after: string | null }>) => {
  try {
    self.postMessage({ counts: calculateChangedLines(data.before, data.after) });
  } catch (error: unknown) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
