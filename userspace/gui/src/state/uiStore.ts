/**
 * 全局 UI 状态（与业务数据无关的轻量开关集合）
 *
 * 当前持有：
 *   - Workspace Open 对话框开关
 *   - .code-workspace 双击三选项对话框（阶段 4 / S4-3）
 *
 * 后续如有更多模态、Toast、状态栏等纯 UI 状态可以继续挂在这里，避免在
 * workspaceStore / editorStore 中混入 UI 表现层逻辑。
 */
import { create } from 'zustand';

/**
 * `.code-workspace` 双击选择对话框的目标信息
 *
 * 由 editorStore.openFile 检测到 .code-workspace 后填充；
 * 用户在对话框中选择处理方式后，再由 dialog 组件自身派发到
 * workspaceStore.openWorkspace（"Open as Workspace"）或继续走
 * editorStore.openFile + forceJson 标志（"Open as JSON File"）。
 */
export interface CodeWorkspaceChoiceTarget {
  /** 文件相对 folder 根的 POSIX 路径 */
  path: string;
  /** 文件所属的 folderId；缺省则使用当前活动 folder */
  folderId?: string;
}

interface UiStateData {
  /** "Open Workspace" 模态对话框是否可见 */
  workspaceOpenDialogVisible: boolean;
  /** `.code-workspace` 双击对话框目标；null 表示未触发 */
  codeWorkspaceChoice: CodeWorkspaceChoiceTarget | null;
}

interface UiActions {
  showWorkspaceOpenDialog: () => void;
  hideWorkspaceOpenDialog: () => void;
  showCodeWorkspaceChoice: (target: CodeWorkspaceChoiceTarget) => void;
  hideCodeWorkspaceChoice: () => void;
}

type UiStore = UiStateData & UiActions;

export const useUiStore = create<UiStore>((set) => ({
  workspaceOpenDialogVisible: false,
  codeWorkspaceChoice: null,
  showWorkspaceOpenDialog: () => set({ workspaceOpenDialogVisible: true }),
  hideWorkspaceOpenDialog: () => set({ workspaceOpenDialogVisible: false }),
  showCodeWorkspaceChoice: (target) => set({ codeWorkspaceChoice: target }),
  hideCodeWorkspaceChoice: () => set({ codeWorkspaceChoice: null }),
}));
