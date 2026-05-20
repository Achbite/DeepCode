/**
 * 工作区状态管理（Zustand store）
 *
 * 维护当前活动工作区与 fallback / lastError 状态。
 * 文件读写需要 folderId 时，组件应从此处选择 activeFolderId 后再调 apiClient。
 *
 * 注意：本 store 与 editorStore 解耦——editorStore 只负责"打开了哪些文件"，
 * 不知道 folderId 来自何处；调用 readFile/writeFile 前由组件层注入 folderId。
 */
import { create } from 'zustand';
import {
  getCurrentWorkspace,
  openWorkspace as runtimeOpenWorkspace,
} from '../services/runtimeAdapter';
import type {
  WorkspaceFolderSpec,
  WorkspaceSpec,
} from '@deepcode/protocol';

interface WorkspaceStateData {
  /** 当前工作区；首次启动 loadCurrent 之前为 null */
  current: WorkspaceSpec | null;
  /** 当前是否使用 fallback 工作区 */
  fallbackUsed: boolean;
  /** 最近一次 openWorkspace 失败原因 */
  lastError: string | null;
  /** 当前选中的 folderId；缺省取 folders[0].id */
  activeFolderId: string | null;
  /** 是否正在加载（首次或刷新） */
  loading: boolean;
}

interface WorkspaceActions {
  /** 从后端拉取最新工作区状态 */
  loadCurrent: () => Promise<void>;
  /** 打开工作区（绝对路径或 .code-workspace 文件） */
  openWorkspace: (path: string) => Promise<{ ok: boolean; message?: string }>;
  /** 切换当前 folder */
  selectFolder: (folderId: string) => void;
}

interface WorkspaceDerived {
  /** 取当前 folder；workspace 未加载或 folders 为空时返回 null */
  getActiveFolder: () => WorkspaceFolderSpec | null;
}

type WorkspaceStore = WorkspaceStateData & WorkspaceActions & WorkspaceDerived;

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  current: null,
  fallbackUsed: false,
  lastError: null,
  activeFolderId: null,
  loading: false,

  getActiveFolder: () => {
    const { current, activeFolderId } = get();
    if (!current || current.folders.length === 0) return null;
    if (activeFolderId) {
      const found = current.folders.find((f) => f.id === activeFolderId);
      if (found) return found;
    }
    return current.folders[0];
  },

  loadCurrent: async () => {
    set({ loading: true });
    const result = await getCurrentWorkspace();
    if (result.ok && result.data) {
      const ws = result.data.current;
      set({
        current: ws,
        fallbackUsed: result.data.fallbackUsed,
        lastError: result.data.lastError,
        activeFolderId: ws.folders[0]?.id ?? null,
        loading: false,
      });
    } else {
      set({
        lastError: result.message ?? '工作区加载失败',
        loading: false,
      });
    }
  },

  openWorkspace: async (path: string) => {
    set({ loading: true });
    const result = await runtimeOpenWorkspace(path);
    if (result.ok && result.data) {
      const ws = result.data.workspace;
      set({
        current: ws,
        fallbackUsed: false,
        lastError: null,
        activeFolderId: ws.folders[0]?.id ?? null,
        loading: false,
      });
      return { ok: true };
    }
    const message = result.message ?? '打开工作区失败';
    set({
      lastError: message,
      loading: false,
    });
    return { ok: false, message };
  },

  selectFolder: (folderId: string) => {
    set({ activeFolderId: folderId });
  },
}));
