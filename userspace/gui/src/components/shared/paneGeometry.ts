/** Widths and keyboard increments for the workbench's resizable regions. */
export const PANE_GEOMETRY = {
  navigation: { initial: 244, min: 200, max: 400, step: 16, reserve: 360 },
  fileTree: { initial: 210, min: 150, max: 360, step: 16, reserve: 180 },
  preview: { initial: 55, min: 30, max: 75, step: 3 },
} as const;

export function boundedPaneWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resizedPaneWidth(start: number, offset: number, direction: 1 | -1, pixelsPerUnit: number, min: number, max: number): number {
  return boundedPaneWidth(start + offset * direction / pixelsPerUnit, min, max);
}
