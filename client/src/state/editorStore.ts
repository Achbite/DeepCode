/**
 * 编辑器状态管理（Zustand store）
 *
 * 维护编辑区中的多 Tab：
 *   - file Tab：磁盘文件（folderId / path / content / dirty / 大小 / 二进制）。
 *   - settings Tab：DeepCode Settings 中心；全局唯一，再次点击 ⚙️ 时切换而不是新建。
 *
 * 工作区耦合：file Tab 的唯一 ID 是 `${folderId}::${path}`，避免不同 folder
 * 下相同相对路径冲突；切换工作区时由调用方自行决定是否清理旧 Tab。
 */
import { create } from 'zustand';
import { readFile, writeFile } from '../services/runtimeAdapter';
import { closeModel } from '../components/editor/CodeEditor';
import { useWorkspaceStore } from './workspaceStore';

// ---- Tab 模型 ----

/** 编辑区 Tab 类型标识 */
export type EditorTabKind = 'file' | 'settings';

/** Settings Tab 的虚拟唯一 ID */
export const SETTINGS_TAB_ID = '__deepcode_settings__';

/** 单个文件 Tab 的内容描述 */
export interface OpenFile {
  /** 所属 folder id；切换工作区后用于识别 Tab 归属 */
  folderId: string;
  /** 文件相对 folder 根的 POSIX 路径 */
  path: string;
  /** 当前编辑器内文本 */
  content: string;
  /** 上一次从磁盘加载或保存后的"基线"内容 */
  originalContent: string;
  /** 是否被修改过且未保存 */
  isDirty: boolean;
  /** 编辑器内存版本；用于自动保存等订阅精确感知内容变更 */
  version: number;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 文件是否被识别为二进制 */
  binary: boolean;
}

/** 编辑区 Tab 抽象 */
export type EditorTab =
  | ({ kind: 'file' } & OpenFile)
  | { kind: 'settings'; id: typeof SETTINGS_TAB_ID; title: string };

interface EditorStateData {
  tabs: EditorTab[];
  activeTabId: string | null;
  saveMessage: string | null;
}

interface EditorActions {
  /**
   * 打开文件（已打开则切换到 tab）；folderId 省略时使用当前活动 folder。
   *
   * `forceJson` （阶段 4 / S4-3）：当为 true 时跳过对 .code-workspace 的拦截，
   * 直接当作普通 JSON 文件读取并在 Monaco 中编辑 / 保存。
   */
  openFile: (
    filePath: string,
    folderId?: string,
    forceJson?: boolean
  ) => Promise<void>;
  openSettings: () => void;
  closeTab: (tabId: string) => void;
  updateContent: (tabId: string, content: string) => void;
  /** 保存文件；支持 tabId 单参数 或 folderId + path 双参数 */
  saveFile: (tabIdOrFolderId: string, path?: string) => Promise<boolean>;
  saveAllDirtyFiles: () => Promise<boolean>;
  discardAllDirtyFiles: () => void;
  setActiveTab: (tabId: string) => void;
  /** 资源管理器重命名后同步已打开文件 Tab 的路径 */
  renamePathInTabs: (folderId: string, oldPath: string, newPath: string) => void;
  /** 切换工作区时调用：关闭所有 file Tab，保留 settings Tab */
  closeAllFileTabs: () => void;
  /** 判断是否有未保存的文件 */
  hasAnyDirtyFile: () => boolean;
}

interface EditorDerived {
  getActiveTab: () => EditorTab | null;
  getActiveFile: () => OpenFile | null;
  getOpenFiles: () => OpenFile[];
}

type EditorStore = EditorStateData & EditorActions & EditorDerived;

// ---- 内部 helper ----

/** 文件 Tab id 由 folderId + path 复合而成 */
export function buildFileTabId(folderId: string, path: string): string {
  return `${folderId}::${path}`;
}

export function getTabId(tab: EditorTab): string {
  return tab.kind === 'file' ? buildFileTabId(tab.folderId, tab.path) : tab.id;
}

function pickNextActive(
  remaining: EditorTab[],
  closingId: string,
  currentActive: string | null
): string | null {
  if (currentActive !== closingId) return currentActive;
  if (remaining.length === 0) return null;
  return getTabId(remaining[remaining.length - 1]);
}

/** 把 .code-workspace 拓展名识别为工作区文件 */
function isCodeWorkspaceFile(path: string): boolean {
  return /\.code-workspace$/i.test(path);
}

const DRAFTS_STORAGE_KEY = 'deepcode.editor.drafts.v1';

interface StoredDraft {
  folderId: string;
  path: string;
  content: string;
  originalContent: string;
  updatedAt: number;
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readDrafts(): Record<string, StoredDraft> {
  if (!canUseLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts: Record<string, StoredDraft>): void {
  if (!canUseLocalStorage()) return;
  window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
}

function persistDraft(tab: Extract<EditorTab, { kind: 'file' }>): void {
  const drafts = readDrafts();
  drafts[getTabId(tab)] = {
    folderId: tab.folderId,
    path: tab.path,
    content: tab.content,
    originalContent: tab.originalContent,
    updatedAt: Date.now(),
  };
  writeDrafts(drafts);
}

function removeDraft(tabId: string): void {
  const drafts = readDrafts();
  if (!(tabId in drafts)) return;
  delete drafts[tabId];
  writeDrafts(drafts);
}

function getUsableDraft(tabId: string, diskContent: string): StoredDraft | null {
  const draft = readDrafts()[tabId];
  if (!draft || draft.content === diskContent) {
    removeDraft(tabId);
    return null;
  }
  if (draft.originalContent !== diskContent) {
    return null;
  }
  return draft;
}

// ---- Zustand store ----

export const useEditorStore = create<EditorStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  saveMessage: null,

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    if (!activeTabId) return null;
    return tabs.find((t) => getTabId(t) === activeTabId) ?? null;
  },

  getActiveFile: () => {
    const tab = get().getActiveTab();
    if (!tab || tab.kind !== 'file') return null;
    const { kind: _kind, ...file } = tab;
    return file as OpenFile;
  },

  getOpenFiles: () => {
    const files: OpenFile[] = [];
    for (const tab of get().tabs) {
      if (tab.kind === 'file') {
        const { kind: _kind, ...file } = tab;
        files.push(file as OpenFile);
      }
    }
    return files;
  },

  // ---- 打开文件 ----
  openFile: async (filePath, folderIdArg, forceJson) => {
    // .code-workspace 双击处理（阶段 4 / S4-3）：
    //   - 默认弹三选项模态：Open as Workspace / Open as JSON File / Cancel
    //   - 调用方传 forceJson=true 表示用户已选择 "Open as JSON File"，跳过拦截走普通读文件流程。
    if (isCodeWorkspaceFile(filePath) && !forceJson) {
      // 动态导入避免循环依赖：uiStore 不反向依赖 editorStore
      const { useUiStore } = await import('./uiStore');
      useUiStore.getState().showCodeWorkspaceChoice({
        path: filePath,
        folderId: folderIdArg,
      });
      return;
    }

    const targetFolderId =
      folderIdArg ?? useWorkspaceStore.getState().getActiveFolder()?.id;
    if (!targetFolderId) {
      set({ saveMessage: '❌ 当前没有可用的 workspace folder' });
      return;
    }

    const tabId = buildFileTabId(targetFolderId, filePath);
    const { tabs } = get();
    const existing = tabs.find(
      (t) => t.kind === 'file' && getTabId(t) === tabId
    );
    if (existing) {
      set({ activeTabId: tabId });
      return;
    }

    const result = await readFile(filePath, targetFolderId);
    if (!result.ok || !result.data) {
      set({ saveMessage: `❌ 打开失败: ${result.message ?? '未知错误'}` });
      return;
    }

    const draft = getUsableDraft(tabId, result.data.content);
    const newTab: EditorTab = {
      kind: 'file',
      folderId: result.data.folderId,
      path: result.data.path,
      content: draft?.content ?? result.data.content,
      originalContent: result.data.content,
      isDirty: Boolean(draft),
      version: 0,
      sizeBytes: result.data.sizeBytes,
      binary: result.data.binary,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: buildFileTabId(newTab.folderId, newTab.path),
    }));
  },

  openSettings: () => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.kind === 'settings');
    if (existing) {
      set({ activeTabId: SETTINGS_TAB_ID });
      return;
    }
    const settingsTab: EditorTab = {
      kind: 'settings',
      id: SETTINGS_TAB_ID,
      title: 'DeepCode Settings',
    };
    set((state) => ({
      tabs: [...state.tabs, settingsTab],
      activeTabId: SETTINGS_TAB_ID,
    }));
  },

  closeTab: (tabId) => {
    set((state) => {
      const closing = state.tabs.find((t) => getTabId(t) === tabId);
      const remaining = state.tabs.filter((t) => getTabId(t) !== tabId);
      if (closing && closing.kind === 'file') {
        closeModel(buildFileTabId(closing.folderId, closing.path));
      }
      return {
        tabs: remaining,
        activeTabId: pickNextActive(remaining, tabId, state.activeTabId),
      };
    });
  },

  updateContent: (tabId, content) => {
    const current = get().tabs.find((t) => getTabId(t) === tabId);
    if (current?.kind === 'file') {
      const next = { ...current, content, isDirty: content !== current.originalContent };
      if (next.isDirty) {
        persistDraft(next);
      } else {
        removeDraft(tabId);
      }
    }
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.kind !== 'file') return t;
        if (getTabId(t) !== tabId) return t;
        return {
          ...t,
          content,
          isDirty: content !== t.originalContent,
          version: t.version + 1,
        };
      }),
    }));
  },

  saveFile: async (arg1: string, arg2?: string) => {
    const tabId = arg2 ? buildFileTabId(arg1, arg2) : arg1;
    const tab = get().tabs.find((t) => getTabId(t) === tabId);
    if (!tab || tab.kind !== 'file') return false;

    const result = await writeFile(tab.path, tab.content, tab.folderId);
    if (result.ok && result.data) {
      removeDraft(tabId);
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.kind !== 'file' || getTabId(t) !== tabId) return t;
          return {
            ...t,
            originalContent: tab.content,
            isDirty: false,
            version: t.version + 1,
            sizeBytes: result.data!.sizeBytes,
          };
        }),
        saveMessage: `✅ ${tab.path.split('/').pop()} 已保存`,
      }));

      setTimeout(() => {
        const cur = get().saveMessage;
        if (cur && cur.startsWith('✅')) {
          set({ saveMessage: null });
        }
      }, 3000);
      return true;
    } else {
      set({
        saveMessage: `❌ 保存失败: ${result.message ?? '未知错误'}`,
      });
      return false;
    }
  },

  saveAllDirtyFiles: async () => {
    const dirtyTabs = get().tabs.filter(
      (tab): tab is Extract<EditorTab, { kind: 'file' }> =>
        tab.kind === 'file' && tab.isDirty
    );
    let ok = true;
    for (const tab of dirtyTabs) {
      const saved = await get().saveFile(buildFileTabId(tab.folderId, tab.path));
      ok = ok && saved;
    }
    return ok;
  },

  discardAllDirtyFiles: () => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.kind !== 'file' || !tab.isDirty) return tab;
        removeDraft(buildFileTabId(tab.folderId, tab.path));
        return {
          ...tab,
          content: tab.originalContent,
          isDirty: false,
          version: tab.version + 1,
        };
      }),
      saveMessage: null,
    }));
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
  },

  renamePathInTabs: (folderId, oldPath, newPath) => {
    const isNested = (path: string) =>
      path === oldPath || path.startsWith(`${oldPath}/`);

    set((state) => {
      let nextActiveTabId = state.activeTabId;
      const tabs = state.tabs.map((tab) => {
        if (tab.kind !== 'file' || tab.folderId !== folderId || !isNested(tab.path)) {
          return tab;
        }
        const oldTabId = buildFileTabId(tab.folderId, tab.path);
        const nextPath =
          tab.path === oldPath
            ? newPath
            : `${newPath}/${tab.path.slice(oldPath.length + 1)}`;
        closeModel(oldTabId);
        const nextTabId = buildFileTabId(tab.folderId, nextPath);
        if (state.activeTabId === oldTabId) {
          nextActiveTabId = nextTabId;
        }
        return { ...tab, path: nextPath };
      });
      return {
        tabs,
        activeTabId: nextActiveTabId,
        saveMessage: `已重命名: ${oldPath.split('/').pop()} → ${newPath.split('/').pop()}`,
      };
    });
  },

  closeAllFileTabs: () => {
    set((state) => {
      // 閲婃斁姣忎釜 file Tab 鐨?model
      for (const tab of state.tabs) {
        if (tab.kind === 'file') {
          closeModel(buildFileTabId(tab.folderId, tab.path));
        }
      }
      const remaining = state.tabs.filter((t) => t.kind !== 'file');
      const nextActive =
        remaining.length > 0 ? getTabId(remaining[remaining.length - 1]) : null;
      return {
        tabs: remaining,
        activeTabId: nextActive,
      };
    });
  },

  /**
   * 鍒ゆ柇鏄惁鏈変换浣曟湭淇濆瓨鐨勬枃浠�
   */
  hasAnyDirtyFile: () => {
    const state = get();
    return state.tabs.some((tab) => tab.kind === 'file' && tab.isDirty);
  },
}));
