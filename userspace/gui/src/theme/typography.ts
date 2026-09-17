export const UI_FONT_FAMILY_SETTING = 'gui.fontFamily';
export const UI_FONT_SIZE_SETTING = 'gui.fontSize';
export const UI_FONT_PRESETS = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif',
  sans: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", "SimSun", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
} as const;

export function uiFontFamily(value: unknown): string {
  if (value === undefined || value === null) return UI_FONT_PRESETS.system;
  if (typeof value !== 'string' || !value.trim()) throw new Error('UI font name cannot be empty.');
  if (Object.hasOwn(UI_FONT_PRESETS, value)) return UI_FONT_PRESETS[value as keyof typeof UI_FONT_PRESETS];
  // A single installed family name, not a CSS declaration or a remote font URL.
  if (value.length > 120 || /[\x00-\x1f;{}<>]/.test(value)) throw new Error('Invalid UI font family name.');
  return `${JSON.stringify(value.trim())}, ${UI_FONT_PRESETS.system}`;
}

export function uiFontSize(value: unknown): number {
  if (value === undefined || value === null) return 14;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 12 || value > 18) throw new Error('UI font size must be an integer from 12 to 18.');
  return value;
}
