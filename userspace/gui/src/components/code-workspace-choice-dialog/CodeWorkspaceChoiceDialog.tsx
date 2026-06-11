/**
 * .code-workspace 双击选择对话框（阶段 4 / S4-3）
 *
 * 触发：editorStore.openFile 检测到 .code-workspace 文件且未带 forceJson 标志
 * 三个动作：
 *   - Open as Workspace：把它作为工作区打开（走 workspaceStore.openWorkspace 绝对路径）
 *   - Open as JSON File：作为 jsonc 文本在 Monaco 中编辑保存（editorStore.openFile + forceJson=true）
 *   - Cancel：什么都不做
 *
 * 视觉风格：与 WorkspaceOpenDialog 同源 dark 模态框；使用本组件局部样式表，避免污染全局。
 */
import React from 'react';
import { useUiStore } from '../../state/uiStore';
import { useEditorStore } from '../../state/editorStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import './codeWorkspaceChoiceDialog.css';

const CodeWorkspaceChoiceDialog: React.FC = () => {
  const target = useUiStore((s) => s.codeWorkspaceChoice);
  const hide = useUiStore((s) => s.hideCodeWorkspaceChoice);
  const openFile = useEditorStore((s) => s.openFile);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const getActiveFolder = useWorkspaceStore((s) => s.getActiveFolder);

  if (!target) return null;

  const fileName = target.path.split('/').pop() ?? target.path;

  const handleOpenAsWorkspace = async () => {
    // 把相对路径解析为绝对路径再调 openWorkspace；后端可解析绝对的 .code-workspace 文件
    const folder = getActiveFolder();
    if (!folder) {
      hide();
      return;
    }
    const absolutePath = `${folder.absolutePath}/${target.path}`;
    hide();
    await openWorkspace(absolutePath);
  };

  const handleOpenAsJson = async () => {
    hide();
    await openFile(target.path, target.folderId, true);
  };

  return (
    <div
      className="cwc-dialog__backdrop"
      onClick={hide}
      role="presentation"
    >
      <div
        className="cwc-dialog__panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cwc-dialog-title"
      >
        <div id="cwc-dialog-title" className="cwc-dialog__title">
          打开 .code-workspace 文件
        </div>
        <div className="cwc-dialog__body">
          <p className="cwc-dialog__file">{fileName}</p>
          <p className="cwc-dialog__hint">
            该文件是 VS Code-style 工作区描述文件。你希望如何处理它？
          </p>
        </div>
        <div className="cwc-dialog__actions">
          <button
            className="cwc-dialog__btn cwc-dialog__btn--text"
            onClick={hide}
          >
            取消
          </button>
          <button
            className="cwc-dialog__btn cwc-dialog__btn--secondary"
            onClick={handleOpenAsJson}
            title="作为 JSON 文件在编辑器中编辑"
          >
            作为 JSON 编辑
          </button>
          <button
            className="cwc-dialog__btn cwc-dialog__btn--primary"
            onClick={handleOpenAsWorkspace}
            title="把该文件作为工作区打开（替换当前工作区）"
          >
            作为工作区打开
          </button>
        </div>
      </div>
    </div>
  );
};

export default CodeWorkspaceChoiceDialog;
