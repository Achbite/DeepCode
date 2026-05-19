/**
 * 应用运行状态管理
 * 使用 Zustand 管理 API / WebSocket 连接状态
 */
import { create } from 'zustand';
import type { ConnectionStatus, AppStatusState } from '../types/ui';

interface AppStatusActions {
  setApiStatus: (status: ConnectionStatus) => void;
  setWsStatus: (status: ConnectionStatus) => void;
  setServerVersion: (version: string) => void;
  setLastHeartbeatAt: (timestamp: string) => void;
  setErrorMessage: (message: string | undefined) => void;
}

const useAppStatusStore = create<AppStatusState & AppStatusActions>((set) => ({
  apiStatus: 'checking' as ConnectionStatus,
  wsStatus: 'checking' as ConnectionStatus,
  serverVersion: undefined,
  lastHeartbeatAt: undefined,
  errorMessage: undefined,
  setApiStatus: (status) => set({ apiStatus: status }),
  setWsStatus: (status) => set({ wsStatus: status }),
  setServerVersion: (version) => set({ serverVersion: version }),
  setLastHeartbeatAt: (timestamp) => set({ lastHeartbeatAt: timestamp }),
  setErrorMessage: (message) => set({ errorMessage: message }),
}));

export default useAppStatusStore;
