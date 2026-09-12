export interface PastedTextInput {
  inputId: string;
  text: string;
}

export const PASTED_TEXT_THRESHOLD = 32 * 1024;

export function isLongPastedText(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > PASTED_TEXT_THRESHOLD;
}

export function pastedTextTitle(text: string): string {
  return (text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? '粘贴的文本').slice(0, 80);
}
