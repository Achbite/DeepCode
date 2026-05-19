/**
 * App 入口组件
 * 初始化 API health 检查和 WebSocket 心跳连接
 * 渲染 WorkbenchLayout 并传递连接状态
 */
import React, { useEffect } from 'react';
import WorkbenchLayout from './layout/WorkbenchLayout';
import useAppStatusStore from '../state/appStatusStore';
import { getHealth } from '../services/apiClient';
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

  // ---- 1. 初始化 API health 检查 ----
  useEffect(() => {
    let cancelled = false;
    const checkApiHealth = async () => {
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

    checkApiHealth();
    // 每 30 秒重新检查一次
    const interval = setInterval(checkApiHealth, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 2. 初始化 WebSocket 心跳 ----
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
