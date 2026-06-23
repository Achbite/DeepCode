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
import { useSettingsStore } from '../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../i18n';
import './codeWorkspaceChoiceDialog.css';

const CodeWorkspaceChoiceDialog: React.FC = () => {
  const target = useUiStore((s) => s.codeWorkspaceChoice);
  const hide = useUiStore((s) => s.hideCodeWorkspaceChoice);
  const openFile = useEditorStore((s) => s.openFile);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const getActiveFolder = useWorkspaceStore((s) => s.getActiveFolder);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

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
          {t(language, 'codeWorkspaceChoice.title')}
        </div>
        <div className="cwc-dialog__body">
          <p className="cwc-dialog__file">{fileName}</p>
          <p className="cwc-dialog__hint">
            {t(language, 'codeWorkspaceChoice.hint')}
          </p>
        </div>
        <div className="cwc-dialog__actions">
          <button
            className="cwc-dialog__btn cwc-dialog__btn--text"
            onClick={hide}
          >
            {t(language, 'codeWorkspaceChoice.cancel')}
          </button>
          <button
            className="cwc-dialog__btn cwc-dialog__btn--secondary"
            onClick={handleOpenAsJson}
            title={t(language, 'codeWorkspaceChoice.openAsJsonTitle')}
          >
            {t(language, 'codeWorkspaceChoice.openAsJson')}
          </button>
          <button
            className="cwc-dialog__btn cwc-dialog__btn--primary"
            onClick={handleOpenAsWorkspace}
            title={t(language, 'codeWorkspaceChoice.openAsWorkspaceTitle')}
          >
            {t(language, 'codeWorkspaceChoice.openAsWorkspace')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CodeWorkspaceChoiceDialog;
