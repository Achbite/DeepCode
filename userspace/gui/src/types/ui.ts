/**
 * 前端 UI 相关类型
 */
export type ConnectionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export interface AppStatusState {
  apiStatus: ConnectionStatus;
  wsStatus: ConnectionStatus;
  serverVersion?: string;
  lastHeartbeatAt?: string;
  errorMessage?: string;
}

/** 全局确认弹窗数据 */
export interface ConfirmDialogAction {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  onClick: () => void | Promise<void>;
}

export interface ConfirmDialogData {
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  actions?: ConfirmDialogAction[];
}
