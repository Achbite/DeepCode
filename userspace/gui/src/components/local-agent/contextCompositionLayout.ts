export interface ContextCompositionLayoutSegment<Key extends string = string> {
  key: Key;
  truePercent: number;
}

export interface ContextCompositionLayout {
  widths: number[];
  focused: boolean;
}

const ACTIVE_FOCUS_PERCENT = 30;
const SURROUNDING_FOCUS_PERCENT = 26;
export const CONTEXT_FOCUS_USED_PERCENT = ACTIVE_FOCUS_PERCENT + SURROUNDING_FOCUS_PERCENT;
const FREE_FOCUS_PERCENT = 100 - CONTEXT_FOCUS_USED_PERCENT;

export function buildContextCompositionLayout<Key extends string>(
  segments: readonly ContextCompositionLayoutSegment<Key>[],
  focusKey: Key | null,
): ContextCompositionLayout {
  const trueWidths = normalizePercentages(
    segments.map((segment) => finiteNonNegative(segment.truePercent)),
  );
  const activeIndex = focusKey === null
    ? -1
    : segments.findIndex((segment) => segment.key === focusKey);
  if (
    activeIndex < 0
    || segments[activeIndex].key === 'free'
    || trueWidths[activeIndex] <= 0
  ) {
    return { widths: trueWidths, focused: false };
  }

  const freeIndexes = segments
    .map((segment, index) => segment.key === 'free' && trueWidths[index] > 0 ? index : -1)
    .filter((index) => index >= 0);
  const surroundingIndexes = segments
    .map((segment, index) => (
      index !== activeIndex
      && segment.key !== 'free'
      && trueWidths[index] > 0
        ? index
        : -1
    ))
    .filter((index) => index >= 0);
  const freeBudget = freeIndexes.length > 0 ? FREE_FOCUS_PERCENT : 0;
  const usedBudget = 100 - freeBudget;
  const surroundingBudget = surroundingIndexes.length > 0
    ? Math.min(SURROUNDING_FOCUS_PERCENT, usedBudget)
    : 0;
  const activeBudget = usedBudget - surroundingBudget;
  const surroundingWeight = surroundingIndexes.reduce(
    (total, index) => total + Math.sqrt(trueWidths[index]),
    0,
  );
  const freeWeight = freeIndexes.reduce(
    (total, index) => total + trueWidths[index],
    0,
  );

  return {
    focused: true,
    widths: segments.map((segment, index) => {
      if (index === activeIndex) return activeBudget;
      if (segment.key === 'free') {
        return freeWeight > 0
          ? freeBudget * (trueWidths[index] / freeWeight)
          : 0;
      }
      if (trueWidths[index] <= 0 || surroundingWeight <= 0) return 0;
      return surroundingBudget * (Math.sqrt(trueWidths[index]) / surroundingWeight);
    }),
  };
}

function normalizePercentages(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return values.map(() => 0);
  return values.map((value) => (value / total) * 100);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
