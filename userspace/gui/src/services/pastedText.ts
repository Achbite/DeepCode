export interface PastedTextInput {
  inputId: string;
  text: string;
}

export const PASTED_TEXT_THRESHOLD = 2_000;
export const PASTED_TEXT_LINE_THRESHOLD = 20;

export function isLongPastedText(text: string): boolean {
  // This is a composer presentation threshold, not an upload size limit.
  return text.length >= PASTED_TEXT_THRESHOLD
    || text.split(/\r\n|\r|\n/u).length >= PASTED_TEXT_LINE_THRESHOLD;
}

export function pastedTextTitle(text: string): string {
  return (text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? '粘贴的文本').slice(0, 80);
}
