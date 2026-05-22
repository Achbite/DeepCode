/**
 * React 应用入口
 *
 * 挂载 App 组件到 DOM。
 *
 * 错误兜底（阶段 5 排查 / 黑屏诊断）：
 *   1. 顶层 window.error / unhandledrejection：捕获 React commit 之前的同步异常，
 *      在 DOM 上显示出来；防止 release 模式下黑屏无信息。
 *   2. ErrorBoundary：捕获 React 组件树渲染时抛出的错误，显示友好提示与堆栈。
 *   定位完成后可以移除 BootstrapErrorPanel，但 ErrorBoundary 应当作为长期基础设施保留。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';

// ---- 1. 启动期同步错误兜底 ----

const ROOT_EL_ID = 'root';

if (typeof performance !== 'undefined') {
  performance.mark('deepcode:react-start');
}

function showBootstrapError(label: string, err: unknown): void {
  // 直接 DOM 操作，避免依赖 React 已经成功挂载
  const root = document.getElementById(ROOT_EL_ID);
  if (!root) return;
  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}\n\n${err.stack ?? ''}`
      : String(err);
  // 使用极简 inline 样式，绕过 CSS 变量未生效的可能性
  root.innerHTML = `
    <div style="
      padding: 24px;
      color: #fff;
      background: #2d1b1b;
      font-family: Consolas, 'Courier New', monospace;
      font-size: 13px;
      height: 100vh;
      overflow: auto;
      box-sizing: border-box;
    ">
      <h2 style="color:#ff6b6b;margin:0 0 12px 0;">DeepCode 启动错误（${label}）</h2>
      <pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:#ddd;">${escapeHtml(message)}</pre>
      <p style="margin-top:16px;color:#888;font-size:12px;">
        如果你看到此页面，表示前端启动期出现异常。请把全文复制给开发者。
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.addEventListener('error', (event) => {
  // 资源加载失败（image / css / script）event.error 为 null，跳过
  if (!event.error) return;
  // eslint-disable-next-line no-console
  console.error('[bootstrap] window.error:', event.error);
  showBootstrapError('window.error', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap] unhandledrejection:', event.reason);
  showBootstrapError('unhandledrejection', event.reason);
});

// ---- 2. React Error Boundary ----

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      const err = this.state.error;
      return (
        <div
          style={{
            padding: 24,
            color: '#fff',
            background: '#2d1b1b',
            fontFamily: "Consolas, 'Courier New', monospace",
            fontSize: 13,
            height: '100vh',
            overflow: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <h2 style={{ color: '#ff6b6b', margin: '0 0 12px 0' }}>
            DeepCode UI 渲染异常
          </h2>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              color: '#ddd',
            }}
          >
            {err.name}: {err.message}
            {'\n\n'}
            {err.stack}
          </pre>
          <p style={{ marginTop: 16, color: '#888', fontSize: 12 }}>
            React 组件树抛错，已被 ErrorBoundary 接住。请把全文复制给开发者。
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---- 3. 挂载 ----

const rootEl = document.getElementById(ROOT_EL_ID);
if (!rootEl) {
  throw new Error('找不到 #root 元素');
}

const root = ReactDOM.createRoot(rootEl);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
