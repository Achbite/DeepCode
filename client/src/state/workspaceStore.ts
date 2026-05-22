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
  saveWorkspaceFile as runtimeSaveWorkspaceFile,
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
  /**
   * 文件树重染染计数器（阶段 4 / S4-2）
   *
   * 每次工作区切换 / 刷新接口调用递增。FileTree useEffect 依赖该字段，
   * 即使 activeFolderId 未变（同 id 不同源事件）也能强制重拉取目录树，
   * 避免“Open Workspace 后文件树仍是旧内容”的 race。
   */
  treeRevision: number;
}

interface WorkspaceActions {
  /** 从后端拉取最新工作区状态 */
  loadCurrent: () => Promise<void>;
  /** 打开工作区（绝对路径或 .code-workspace 文件） */
  openWorkspace: (path: string) => Promise<{ ok: boolean; message?: string }>;
  /** 将当前 folder 保存为 .code-workspace 文件，并切换到该 workspace 文件 */
  saveWorkspaceFile: (fileName?: string) => Promise<{ ok: boolean; path?: string; message?: string }>;
  /** 切换当前 folder */
  selectFolder: (folderId: string) => void;
  /** 手动递增 treeRevision（阶段 4 / S4-2），用于新建 / 删除 / 重命名后主动刷新文件树 */
  bumpTreeRevision: () => void;
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
  treeRevision: 0,

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
      set((state) => ({
        current: ws,
        fallbackUsed: result.data!.fallbackUsed,
        lastError: result.data!.lastError,
        activeFolderId: ws?.folders[0]?.id ?? null,
        loading: false,
        treeRevision: state.treeRevision + 1,
      }));
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
      set((state) => ({
        current: ws,
        fallbackUsed: false,
        lastError: null,
        activeFolderId: ws.folders[0]?.id ?? null,
        loading: false,
        treeRevision: state.treeRevision + 1,
      }));
      return { ok: true };
    }
    const message = result.message ?? '打开工作区失败';
    set({
      lastError: message,
      loading: false,
    });
    return { ok: false, message };
  },

  saveWorkspaceFile: async (fileName?: string) => {
    const folderId = get().activeFolderId ?? get().current?.folders[0]?.id;
    if (!folderId) {
      const message = '当前没有可保存的 workspace folder';
      set({ lastError: message });
      return { ok: false, message };
    }

    set({ loading: true });
    const result = await runtimeSaveWorkspaceFile({ folderId, fileName });
    if (result.ok && result.data) {
      const ws = result.data.workspace;
      set((state) => ({
        current: ws,
        fallbackUsed: false,
        lastError: null,
        activeFolderId: ws.folders[0]?.id ?? null,
        loading: false,
        treeRevision: state.treeRevision + 1,
      }));
      return { ok: true, path: result.data.workspaceFilePath };
    }

    const message = result.message ?? '保存 workspace 文件失败';
    set({
      lastError: message,
      loading: false,
    });
    return { ok: false, message };
  },

  selectFolder: (folderId: string) => {
    set({ activeFolderId: folderId });
  },

  bumpTreeRevision: () => {
    set((state) => ({ treeRevision: state.treeRevision + 1 }));
  },
}));
