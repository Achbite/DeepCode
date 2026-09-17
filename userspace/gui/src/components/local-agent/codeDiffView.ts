import { EditorView } from '@codemirror/view';
import { getChunks, unifiedMergeView } from '@codemirror/merge';
import type { Language } from '@codemirror/language';
import { UI_PALETTE } from '../../theme/palette';
import { codeViewerExtensions } from './codeViewer';

export function createCodeDiffView(parent: HTMLElement, before: string, after: string, language: Language | null, dark: boolean): EditorView {
  const colors = UI_PALETTE.diff[dark ? 'dark' : 'light'];
  const view = new EditorView({
    parent,
    doc: after,
    extensions: [
      codeViewerExtensions(language, dark),
      EditorView.lineWrapping,
      unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 2, minSize: 3 } }),
      EditorView.theme({
        '.cm-insertedLine, .cm-changedLine': { backgroundColor: colors['diffEditor.insertedLineBackground'] },
        '.cm-deletedChunk': { backgroundColor: colors['diffEditor.removedLineBackground'] },
        '.cm-insertedText': { backgroundColor: colors['diffEditor.insertedTextBackground'] },
        '.cm-deletedText': { backgroundColor: colors['diffEditor.removedTextBackground'] },
        '.cm-collapsedLines': { backgroundColor: colors['diffEditor.unchangedRegionBackground'], color: colors['diffEditor.unchangedRegionForeground'] },
      }),
    ],
  });
  const firstChange = getChunks(view.state)?.chunks[0];
  if (firstChange) view.dispatch({ effects: EditorView.scrollIntoView(firstChange.fromB, { y: 'center' }) });
  return view;
}
