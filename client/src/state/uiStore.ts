/**
 * 全局 UI 状态（与业务数据无关的轻量开关集合）
 *
 * 当前仅持有 Workspace Open 对话框的开关状态；后续如有更多模态、Toast、
 * 状态栏等纯 UI 状态可以继续挂在这里，避免在 workspaceStore / editorStore
 * 中混入 UI 表现层逻辑。
 */
import { create } from 'zustand';

interface UiStateData {
  /** "Open Workspace" 模态对话框是否可见 */
  workspaceOpenDialogVisible: boolean;
}

interface UiActions {
  showWorkspaceOpenDialog: () => void;
  hideWorkspaceOpenDialog: () => void;
}

type UiStore = UiStateData & UiActions;

export const useUiStore = create<UiStore>((set) => ({
  workspaceOpenDialogVisible: false,
  showWorkspaceOpenDialog: () => set({ workspaceOpenDialogVisible: true }),
  hideWorkspaceOpenDialog: () => set({ workspaceOpenDialogVisible: false }),
}));
