/**
 * 基本文件编辑器组件
 *
 * 首期实现：textarea + 行号面板 + 状态栏。
 * 阶段 5 后续将替换为 Monaco Editor，本组件只承担"已能打开/编辑/保存"的最小闭环。
 *
 * 关键修复点（相对早期版本）：
 *   1. 行号面板使用同一 scrollTop 与 textarea 同步，整体由 textarea 滚动驱动。
 *   2. 编辑器状态栏不再硬编码列号，根据光标实时计算。
 *   3. Tab 键不再失焦，转为插入两空格缩进。
 *   4. 大文件 / 二进制文件给出只读提示。
 *   5. 所有 hooks 调用全部位于组件顶部，无条件提前返回，遵守 React Hooks 规则。
 */
import React, { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import './codeEditor.css';

interface CodeEditorProps {
  /** 当前打开的文件路径（null 表示无文件） */
  filePath: string | null;
  /** 文件内容 */
  content: string;
  /** 内容变更回调 */
  onContentChange: (content: string) => void;
  /** 是否处于已修改未保存状态 */
  isDirty: boolean;
  /** 是否为二进制（只读展示） */
  binary?: boolean;
  /** 文件大小，字节 */
  sizeBytes?: number;
  /** 保存文件回调 */
  onSave: (filePath: string, content: string) => void;
}

// ---- 编辑器常量 ----
const TAB_SIZE = 2;

const CodeEditor: React.FC<CodeEditorProps> = ({
  filePath,
  content,
  onContentChange,
  isDirty,
  binary = false,
  sizeBytes = 0,
  onSave,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);

  // ---- 行计算（content 变化才重算） ----
  const lineCount = useMemo(() => {
    if (!content) return 1;
    let count = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) count++;
    }
    return count;
  }, [content]);

  // ---- 行号文本（纯文本 pre 渲染，避免大文件 DOM 爆炸） ----
  const lineNumbersText = useMemo(() => {
    const arr = new Array<string>(lineCount);
    for (let i = 0; i < lineCount; i++) {
      arr[i] = String(i + 1);
    }
    return arr.join('\n');
  }, [lineCount]);

  // ---- 滚动同步：textarea 滚动 -> 行号面板 ----
  const syncScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  // 内容变化后强制对齐一次（如外部覆盖了 content）
  useEffect(() => {
    syncScroll();
  }, [content, syncScroll]);

  // ---- 光标位置追踪 ----
  const updateCursor = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = content.substring(0, textarea.selectionStart);
    const lines = before.split('\n');
    setCursorLine(lines.length);
    setCursorCol(lines[lines.length - 1].length + 1);
  }, [content]);

  // ---- 键盘处理：Ctrl+S 保存、Tab 缩进 ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+S / Cmd+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (filePath && isDirty) {
          onSave(filePath, content);
        }
        return;
      }

      // Tab：插入两空格而非失焦
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const indent = ' '.repeat(TAB_SIZE);
        const next =
          content.substring(0, start) + indent + content.substring(end);
        onContentChange(next);
        // 在下一帧把光标定位到缩进末尾
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            const pos = start + indent.length;
            textareaRef.current.selectionStart = pos;
            textareaRef.current.selectionEnd = pos;
          }
        });
        return;
      }
    },
    [filePath, isDirty, content, onSave, onContentChange]
  );

  // ---- 空状态 ----
  if (!filePath) {
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

  // ---- 二进制：只读提示 ----
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

  return (
    <div className="code-editor">
      <div className="code-editor__body">
        {/* ---- 行号面板 ---- */}
        <div ref={lineNumbersRef} className="code-editor__line-numbers">
          <pre className="code-editor__line-numbers-text">{lineNumbersText}</pre>
        </div>

        {/* ---- 文本编辑区 ---- */}
        <textarea
          ref={textareaRef}
          className="code-editor__textarea"
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          spellCheck={false}
          wrap="off"
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
          <span>Spaces: {TAB_SIZE}</span>
          <span>Plain Text</span>
          {isDirty && <span className="code-editor__dirty-flag">未保存</span>}
        </div>
      </div>
    </div>
  );
};

export default CodeEditor;
