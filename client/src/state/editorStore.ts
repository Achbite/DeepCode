/**
 * 编辑器状态管理（Zustand store）
 *
 * 维护编辑区中的多 Tab：
 *   - file Tab：磁盘文件（path / content / dirty / 大小 / 二进制）。
 *   - settings Tab：DeepCode Settings 中心；全局唯一，再次点击 ⚙️ 时切换而不是新建。
 *
 * 对 WorkbenchLayout / FileTree / CodeEditor 暴露：
 *   - openFile / closeFile / updateContent / saveFile / setActiveTab
 *   - openSettings：在主编辑区打开（或聚焦）唯一的 Settings Tab，模拟 VSCode 行为
 *
 * 选择器辅助：
 *   - getOpenFiles：仅返回 file 类型的 Tab，方便文件树等模块读取
 *   - getActiveFile：当前活跃 Tab 是 file 时返回；settings 时返回 null
 */
import { create } from 'zustand';
import { readFile, writeFile } from '../services/apiClient';

// ---- Tab 模型 ----

/** 编辑区 Tab 类型标识 */
export type EditorTabKind = 'file' | 'settings';

/** Settings Tab 的虚拟唯一 ID，避免与文件路径冲突 */
export const SETTINGS_TAB_ID = '__deepcode_settings__';

/** 单个文件 Tab 的内容描述 */
export interface OpenFile {
  /** 文件相对工作区根的 POSIX 路径，同时作为 Tab id 使用 */
  path: string;
  /** 当前编辑器内文本（dirty 时与 originalContent 不同） */
  content: string;
  /** 上一次从磁盘加载或保存后的"基线"内容 */
  originalContent: string;
  /** 是否被修改过且未保存 */
  isDirty: boolean;
  /** 文件大小（字节）；用于编辑器侧大文件提示 */
  sizeBytes: number;
  /** 文件是否被识别为二进制；二进制只读 */
  binary: boolean;
}

/** 编辑区 Tab 抽象：file 复用 OpenFile，settings 只作为占位标记 */
export type EditorTab =
  | ({ kind: 'file' } & OpenFile)
  | { kind: 'settings'; id: typeof SETTINGS_TAB_ID; title: string };

interface EditorStateData {
  /** 编辑区中所有 Tab，按打开顺序排列 */
  tabs: EditorTab[];
  /** 当前活跃 Tab 的 id：file 时为 path，settings 时为 SETTINGS_TAB_ID */
  activeTabId: string | null;
  /** 保存反馈（仅 file Tab 触发） */
  saveMessage: string | null;
}

interface EditorActions {
  /** 打开文件（已打开则切换到 tab） */
  openFile: (filePath: string) => Promise<void>;
  /** 打开（或聚焦）唯一的 Settings Tab */
  openSettings: () => void;
  /** 关闭某个 Tab */
  closeTab: (tabId: string) => void;
  /** 更新文件文本内容（仅修改内存，不落盘）；只对 file Tab 生效 */
  updateContent: (filePath: string, content: string) => void;
  /** 保存当前文件到磁盘 */
  saveFile: (filePath: string, content: string) => Promise<void>;
  /** 切换活跃 Tab */
  setActiveTab: (tabId: string) => void;
}

interface EditorDerived {
  /** 当前活跃 Tab；可能是 file / settings / null */
  getActiveTab: () => EditorTab | null;
  /** 当前活跃文件；activeTab 不是 file 时返回 null */
  getActiveFile: () => OpenFile | null;
  /** 仅返回 file 类型的 Tab，作为派生快照 */
  getOpenFiles: () => OpenFile[];
}

type EditorStore = EditorStateData & EditorActions & EditorDerived;

// ---- 内部 helper ----

/** 关闭 Tab 后挑选下一个活跃 Tab */
function pickNextActive(
  remaining: EditorTab[],
  closingId: string,
  currentActive: string | null
): string | null {
  if (currentActive !== closingId) {
    return currentActive;
  }
  if (remaining.length === 0) {
    return null;
  }
  return getTabId(remaining[remaining.length - 1]);
}

/** 取出 Tab 的 id 字段（统一 file / settings） */
function getTabId(tab: EditorTab): string {
  return tab.kind === 'file' ? tab.path : tab.id;
}

// ---- Zustand store ----

export const useEditorStore = create<EditorStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  saveMessage: null,

  // ---- 派生 ----
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
  openFile: async (filePath) => {
    const { tabs } = get();

    // 已打开：直接切到该 Tab，不重新读取（避免覆盖未保存内容）
    const existing = tabs.find(
      (t) => t.kind === 'file' && t.path === filePath
    );
    if (existing) {
      set({ activeTabId: filePath });
      return;
    }

    const result = await readFile(filePath);
    if (!result.ok || !result.data) {
      set({ saveMessage: `❌ 打开失败: ${result.message ?? '未知错误'}` });
      return;
    }

    const newTab: EditorTab = {
      kind: 'file',
      path: result.data.path,
      content: result.data.content,
      originalContent: result.data.content,
      isDirty: false,
      sizeBytes: result.data.sizeBytes,
      binary: result.data.binary,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: result.data!.path,
    }));
  },

  // ---- 打开 / 聚焦 Settings ----
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

  // ---- 关闭 Tab（file / settings 共用） ----
  closeTab: (tabId) => {
    set((state) => {
      const remaining = state.tabs.filter((t) => getTabId(t) !== tabId);
      return {
        tabs: remaining,
        activeTabId: pickNextActive(remaining, tabId, state.activeTabId),
      };
    });
  },

  // ---- 更新文件内容（仅 file Tab） ----
  updateContent: (filePath, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.kind === 'file' && t.path === filePath
          ? { ...t, content, isDirty: content !== t.originalContent }
          : t
      ),
    }));
  },

  // ---- 保存文件 ----
  saveFile: async (filePath, content) => {
    const result = await writeFile(filePath, content);
    if (result.ok && result.data) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.kind === 'file' && t.path === filePath
            ? {
                ...t,
                originalContent: content,
                isDirty: false,
                sizeBytes: result.data!.sizeBytes,
              }
            : t
        ),
        saveMessage: `✅ ${filePath.split('/').pop()} 已保存`,
      }));

      // 3 秒后清除提示，仅当当前消息仍是这条保存提示时
      setTimeout(() => {
        const cur = get().saveMessage;
        if (cur && cur.startsWith('✅')) {
          set({ saveMessage: null });
        }
      }, 3000);
    } else {
      set({
        saveMessage: `❌ 保存失败: ${result.message ?? '未知错误'}`,
      });
    }
  },

  // ---- 切换活跃 Tab ----
  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
  },
}));
