export function nextEnabledIndex(enabled: readonly boolean[], current: number, key: string): number {
  const indices = enabled.flatMap((value, index) => value ? [index] : []);
  if (!indices.length) return -1;
  if (key === 'Home') return indices[0];
  if (key === 'End') return indices[indices.length - 1];
  const backwards = key === 'ArrowUp' || key === 'ArrowLeft';
  const position = indices.indexOf(current);
  if (position < 0) return backwards ? indices[indices.length - 1] : indices[0];
  return indices[(position + (backwards ? -1 : 1) + indices.length) % indices.length];
}
