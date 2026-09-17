import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import './codeViewer.css';

export async function loadCodeLanguage(name: string, filename = ''): Promise<Language | null> {
  const description = (name ? LanguageDescription.matchLanguageName(languages, name) : null)
    ?? LanguageDescription.matchFilename(languages, filename);
  return description ? (await description.load()).language : null;
}

export interface CodeSpan { text: string; className?: string }

/** Use the viewer's parser without creating an editor for each message. */
export async function highlightCode(code: string, name: string): Promise<CodeSpan[]> {
  const language = await loadCodeLanguage(name);
  if (!language) return [{ text: code }];
  const spans: CodeSpan[] = [];
  let offset = 0;
  highlightTree(language.parser.parse(code), classHighlighter, (from, to, className) => {
    if (from > offset) spans.push({ text: code.slice(offset, from) });
    spans.push({ text: code.slice(from, to), className });
    offset = to;
  });
  if (offset < code.length) spans.push({ text: code.slice(offset) });
  return spans;
}
