const REPLACEMENT_CHAR_PATTERN = /\uFFFD+/g;
const QUESTION_RUN_PATTERN = /\?{4,}/g;

function hasLikelyCorruptedQuestionRuns(text: string): boolean {
  const questionCount = (text.match(/\?/g) ?? []).length;
  if (questionCount < 4) return false;
  const visibleLength = text.replace(/\s/g, '').length;
  return visibleLength > 0 && questionCount / visibleLength > 0.25;
}

function sanitizeLine(line: string): string {
  const text = line.replace(REPLACEMENT_CHAR_PATTERN, '').trim();
  if (!text) return '';
  if (hasLikelyCorruptedQuestionRuns(text)) return '';
  return text.replace(QUESTION_RUN_PATTERN, '...');
}

export function sanitizeDisplayText(value: string): string {
  const lines = value
    .replace(REPLACEMENT_CHAR_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(sanitizeLine)
    .filter(Boolean);

  if (lines.length === 0 && value.trim()) {
    return 'Message hidden because it contains invalid encoding.';
  }

  return lines.join('\n').trim();
}

export function compactDisplayText(value: string, limit = 140): string {
  const normalized = sanitizeDisplayText(value).replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}
