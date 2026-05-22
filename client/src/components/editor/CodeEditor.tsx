/**
 * 基本文件编辑器组件（Monaco Editor 版本）
 *
 * 接入要点：
 *   1. 使用 @monaco-editor/react 的 Editor 组件实现语法高亮、Ctrl+S 保存等；
 *   2. 每个 modelKey 对应一个 ITextModel；关闭 Tab 时由外部调用 closeModel(modelKey) 释放；
 *   3. 根据 filePath 扩展名推断 languageId，未知类型默认 plaintext；
 *   4. value 受控；onChange 回调驱动 editorStore；
 *   5. 二进制文件 / 超过 16 MiB 大文件给出只读提示；超过 4 MiB 给出性能预警；
 *   6. 状态栏显示行/列/语言/编码/大小/dirty；
 *   7. Ctrl+S / Cmd+S 触发 onSave。
 */
import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useEditorOptions } from '../../state/settingsStore';
import { registerModel } from './modelRegistry';
import './codeEditor.css';

// ---- 公共接口 ----
interface CodeEditorProps {
  /** 当前打开的文件路径（null 表示无文件） */
  filePath: string | null;
  /** modelKey：editorStore 中的 Tab id（folderId::path），用于唯一定位 ITextModel */
  modelKey: string | null;
  /** 文件内容 */
  content: string;
  /** 内容变更回调 */
  onContentChange: (content: string) => void;
  /** 是否处于已修改未保存状态 */
  isDirty: boolean;
  /** 是否为二进制 */
  binary?: boolean;
  /** 文件大小，字节 */
  sizeBytes?: number;
  /** 保存文件回调（参数为 modelKey） */
  onSave: (modelKey: string) => void;
}

// ---- 编辑器常量 ----
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
  // .code-workspace（VSCode 工作区文件）：阶段 4 / S4-3 起允许在 Monaco 中编辑保存，
  // 实际文件内容是允许注释的 JSON（jsonc），与 .vscode/settings.json 同语言。
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
      // eslint-disable-next-line no-bitwise
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        if (modelKey) {
          onSave(modelKey);
        }
      }
    );

    editor.addCommand(
      // eslint-disable-next-line no-bitwise
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

  // ---- 空状态 ----
  if (!filePath || !modelKey) {
    return (
      <div className="code-editor code-editor--empty">
        <div className="code-editor__empty-inner">
          <div className="code-editor__empty-icon">📄</div>
          <div>打开一个文件开始编辑</div>
          <div className="code-editor__empty-hint">
            使用左侧文件树选择文件
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
          <div className="code-editor__notice-title">二进制文件</div>
          <div className="code-editor__notice-body">
            {filePath} 为二进制文件，当前阶段不在编辑器中展示。
          </div>
          <div className="code-editor__notice-hint">
            大小：{sizeBytes.toLocaleString()} 字节
          </div>
        </div>
      </div>
    );
  }

  // ---- 超大文件 ----
  if (sizeBytes > LARGE_FILE_HARD_THRESHOLD) {
    return (
      <div className="code-editor code-editor--readonly">
        <div className="code-editor__notice">
          <div className="code-editor__notice-title">超大文件</div>
          <div className="code-editor__notice-body">
            {filePath} 大小为 {sizeBytes.toLocaleString()} 字节，超过{' '}
            {(LARGE_FILE_HARD_THRESHOLD / 1024 / 1024).toFixed(0)} MiB 阈值，
            当前以只读提示方式展示，不在编辑器中打开。
          </div>
          <div className="code-editor__notice-hint">
            提示：Monaco 打开大文件可能导致性能问题
          </div>
        </div>
      </div>
    );
  }

  // ---- Monaco 编辑器主体 ----
  return (
    <div className="code-editor">
      {sizeBytes > LARGE_FILE_WARNING_THRESHOLD && (
        <div className="code-editor__large-file-warning">
          文件超过 4 MiB，编辑与保存可能略有延迟。
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
          <span>行 {cursorLine}, 列 {cursorCol}</span>
          <span>UTF-8</span>
          <span>{sizeBytes.toLocaleString()} B</span>
        </div>
        <div className="code-editor__statusbar-right">
          <span>{editorOptions.insertSpaces ? 'Spaces' : 'Tab'}: {editorOptions.tabSize}</span>
          <span>{monacoLanguage}</span>
          {isDirty && <span className="code-editor__dirty-flag">未保存</span>}
        </div>
      </div>
    </div>
  );
};

export default CodeEditor;
