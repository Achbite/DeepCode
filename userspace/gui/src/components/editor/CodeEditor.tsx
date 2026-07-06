
import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useEditorOptions, useSettingsStore } from '../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../i18n';
import { registerModel } from './modelRegistry';
import './codeEditor.css';

interface CodeEditorProps {
  filePath: string | null;
  modelKey: string | null;
  content: string;
  onContentChange: (content: string) => void;
  isDirty: boolean;
  binary?: boolean;
  sizeBytes?: number;
  onSave: (modelKey: string) => void;
}

const LARGE_FILE_WARNING_THRESHOLD = 4 * 1024 * 1024; // 4 MiB
const LARGE_FILE_HARD_THRESHOLD = 16 * 1024 * 1024; // 16 MiB

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  rs: 'rust',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  r: 'r',
  lua: 'lua',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  vue: 'html',
  dart: 'dart',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  gitignore: 'plaintext',
  env: 'plaintext',
};

function inferLanguageId(filePath: string | null): string {
  if (!filePath) return 'plaintext';
  if (/\.code-workspace$/i.test(filePath)) return 'jsonc';
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext';
}

const CodeEditor: React.FC<CodeEditorProps> = ({
  filePath,
  modelKey,
  content,
  onContentChange,
  isDirty,
  binary = false,
  sizeBytes = 0,
  onSave,
}) => {
  const monacoRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [monacoLanguage, setMonacoLanguage] = useState('plaintext');
  const editorOptions = useEditorOptions();
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

  useEffect(() => {
    setMonacoLanguage(inferLanguageId(filePath));
  }, [filePath]);

  const updateCursor = useCallback(() => {
    const editor = monacoRef.current;
    if (!editor) return;
    const pos = editor.getPosition();
    if (pos) {
      setCursorLine(pos.lineNumber);
      setCursorCol(pos.column);
    }
  }, []);

  const applyEditorOptions = useCallback(() => {
    const editor = monacoRef.current;
    if (!editor) return;
    editor.updateOptions({
      fontSize: editorOptions.fontSize,
      fontFamily: editorOptions.fontFamily,
      wordWrap: editorOptions.wordWrap as any,
      renderWhitespace: editorOptions.renderWhitespace as any,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true,
      links: true,
      automaticLayout: true,
    });
    const model = editor.getModel();
    model?.updateOptions({
      tabSize: editorOptions.tabSize,
      insertSpaces: editorOptions.insertSpaces,
    });
  }, [editorOptions]);

  useEffect(() => {
    applyEditorOptions();
  }, [applyEditorOptions]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    monacoRef.current = editor;
    if (modelKey) {
      registerModel(modelKey, editor.getModel());
    }

    editor.onDidChangeCursorPosition(() => {
      updateCursor();
    });
    updateCursor();
    applyEditorOptions();

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        if (modelKey) {
          onSave(modelKey);
        }
      }
    );

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA,
      () => {
        void editor.getAction('editor.action.selectAll')?.run();
      }
    );
  }, [modelKey, onSave, updateCursor, applyEditorOptions]);

  useEffect(() => {
    if (!modelKey) return;
    registerModel(modelKey, monacoRef.current?.getModel() ?? null);
  }, [modelKey, content]);

  if (!filePath || !modelKey) {
    return (
      <div className="code-editor code-editor--empty">
        <div className="code-editor__empty-inner">
          <div className="code-editor__empty-icon">📄</div>
          <div>{t(language, 'editor.empty.title')}</div>
          <div className="code-editor__empty-hint">
            {t(language, 'editor.empty.hint')}
          </div>
        </div>
      </div>
    );
  }

  // ---- 二进制 ----
  if (binary) {
    return (
      <div className="code-editor code-editor--readonly">
        <div className="code-editor__notice">
          <div className="code-editor__notice-title">{t(language, 'editor.notice.binaryTitle')}</div>
          <div className="code-editor__notice-body">
            {t(language, 'editor.notice.binaryBody', { filePath })}
          </div>
          <div className="code-editor__notice-hint">
            {t(language, 'editor.notice.sizeBytes', { size: sizeBytes.toLocaleString() })}
          </div>
        </div>
      </div>
    );
  }

  if (sizeBytes > LARGE_FILE_HARD_THRESHOLD) {
    return (
      <div className="code-editor code-editor--readonly">
        <div className="code-editor__notice">
          <div className="code-editor__notice-title">{t(language, 'editor.notice.largeTitle')}</div>
          <div className="code-editor__notice-body">
            {t(language, 'editor.notice.largeBody', {
              filePath,
              size: sizeBytes.toLocaleString(),
              threshold: (LARGE_FILE_HARD_THRESHOLD / 1024 / 1024).toFixed(0),
            })}
          </div>
          <div className="code-editor__notice-hint">
            {t(language, 'editor.notice.largeHint')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="code-editor">
      {sizeBytes > LARGE_FILE_WARNING_THRESHOLD && (
        <div className="code-editor__large-file-warning">
          {t(language, 'editor.notice.largeWarning', {
            threshold: (LARGE_FILE_WARNING_THRESHOLD / 1024 / 1024).toFixed(0),
          })}
        </div>
      )}
      <div className="code-editor__body">
        <Editor
          className="code-editor__monaco"
          height="100%"
          language={monacoLanguage}
          value={content}
          onChange={(value) => onContentChange(value ?? '')}
          onMount={handleEditorMount}
          theme={editorOptions.theme}
          options={{
            fontSize: editorOptions.fontSize,
            fontFamily: editorOptions.fontFamily,
            tabSize: editorOptions.tabSize,
            insertSpaces: editorOptions.insertSpaces,
            minimap: { enabled: false },
            wordWrap: editorOptions.wordWrap as any,
            scrollBeyondLastLine: false,
            renderWhitespace: editorOptions.renderWhitespace as any,
            lineNumbers: 'on',
            glyphMargin: false,
            folding: true,
            links: true,
            automaticLayout: true,
          }}
          path={modelKey}
        />
      </div>

      {/* ---- 底部状态栏 ---- */}
      <div className="code-editor__statusbar">
        <div className="code-editor__statusbar-left">
          <span>{t(language, 'editor.status.cursor', { line: cursorLine, column: cursorCol })}</span>
          <span>UTF-8</span>
          <span>{sizeBytes.toLocaleString()} B</span>
        </div>
        <div className="code-editor__statusbar-right">
          <span>{editorOptions.insertSpaces ? 'Spaces' : 'Tab'}: {editorOptions.tabSize}</span>
          <span>{monacoLanguage}</span>
          {isDirty && <span className="code-editor__dirty-flag">{t(language, 'editor.status.unsaved')}</span>}
        </div>
      </div>
    </div>
  );
};

export default CodeEditor;
