/**
 * 应用运行状态管理
 * 使用 Zustand 管理 API 连接状态
 */
import { create } from 'zustand';
import type { ConnectionStatus, AppStatusState } from '../types/ui';

interface AppStatusActions {
  setApiStatus: (status: ConnectionStatus) => void;
  setServerVersion: (version: string) => void;
  setErrorMessage: (message: string | undefined) => void;
}

const useAppStatusStore = create<AppStatusState & AppStatusActions>((set) => ({
  apiStatus: 'checking' as ConnectionStatus,
  serverVersion: undefined,
  errorMessage: undefined,
  setApiStatus: (status) => set({ apiStatus: status }),
  setServerVersion: (version) => set({ serverVersion: version }),
  setErrorMessage: (message) => set({ errorMessage: message }),
}));

export default useAppStatusStore;
