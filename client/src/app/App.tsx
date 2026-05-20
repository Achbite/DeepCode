/**
 * App 入口组件
 *
 * 启动顺序：
 *   1. 拉取一次工作区状态（确保 folder 列表存在）；
 *   2. 启动 API health 检查 + 30s 周期；
 *   3. 启动 WebSocket 心跳。
 */
import React, { useEffect } from 'react';
import WorkbenchLayout from './layout/WorkbenchLayout';
import useAppStatusStore from '../state/appStatusStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import {
  getRuntimeType,
  getRuntimeStatus,
} from '../services/runtimeAdapter';
import {
  connectHeartbeat,
  disconnectHeartbeat,
} from '../services/heartbeatSocket';

const App: React.FC = () => {
  const {
    apiStatus,
    wsStatus,
    serverVersion,
    lastHeartbeatAt,
    setApiStatus,
    setServerVersion,
    setErrorMessage,
  } = useAppStatusStore();

  const loadWorkspace = useWorkspaceStore((s) => s.loadCurrent);

  // ---- 1. 启动时加载工作区 ----
  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // ---- 2. 运行时状态检测 + API health 检查 ----
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const checkRuntimeAndHealth = async () => {
      const runtimeStatus = await getRuntimeStatus();
      if (cancelled) return;

      if (runtimeStatus.runtime === 'tauri') {
        // Tauri 模式：runtime 在进程生命周期内不会变，置位即可，无需轮询
        setApiStatus('connected');
        setServerVersion(runtimeStatus.version);
        return;
      }

      // Web 模式：HTTP health check
      const { getHealth } = await import('../services/apiClient');
      const result = await getHealth();
      if (cancelled) return;
      if (result.ok && result.data) {
        setApiStatus('connected');
        setServerVersion(result.data.version);
      } else {
        setApiStatus('error');
        setErrorMessage(result.message || 'API 不可达');
      }
    };

    // 首次执行；Web 模式追加 30s 轮询；Tauri 模式不轮询
    (async () => {
      await checkRuntimeAndHealth();
      if (cancelled) return;
      if (getRuntimeType() === 'web') {
        interval = setInterval(checkRuntimeAndHealth, 30000);
      }
    })();

    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 3. WebSocket 心跳 ----
  useEffect(() => {
    connectHeartbeat();
    return () => {
      disconnectHeartbeat();
    };
  }, []);

  return (
    <WorkbenchLayout
      apiStatus={apiStatus}
      wsStatus={wsStatus}
      serverVersion={serverVersion}
      lastHeartbeatAt={lastHeartbeatAt}
    />
  );
};

export default App;
