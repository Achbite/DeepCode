import React from 'react';
import ReactDOM from 'react-dom/client';
import DeepCodeGuiApp from './DeepCodeGuiApp';

function formatBootstrapError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  try {
    return JSON.stringify(reason, null, 2);
  } catch {
    return String(reason);
  }
}

function renderBootstrapError(reason: unknown): void {
  const root = document.getElementById('root');
  if (!root) return;
  const message = formatBootstrapError(reason);
  root.innerHTML = '';
  const shell = document.createElement('div');
  shell.className = 'codex-bootstrap-error';
  shell.innerHTML = `
    <div class="codex-bootstrap-error__card">
      <h1>DeepCode-GUI 启动失败</h1>
      <p>前端工作台没有完成渲染。下面是启动阶段错误，便于定位打包白屏问题。</p>
      <pre></pre>
    </div>
  `;
  const pre = shell.querySelector('pre');
  if (pre) pre.textContent = message;
  root.appendChild(shell);
}

window.addEventListener('error', (event) => {
  console.error('[DeepCode-GUI bootstrap]', event.error ?? event.message);
  renderBootstrapError(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[DeepCode-GUI bootstrap]', event.reason);
  renderBootstrapError(event.reason);
});

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[DeepCode-GUI]', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="codex-bootstrap-error">
          <div className="codex-bootstrap-error__card">
            <h1>DeepCode-GUI 渲染失败</h1>
            <p>React 工作台启动后遇到异常。</p>
            <pre>{this.state.error.stack ?? this.state.error.message}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Cannot find #root element');
}

const isTauriShell =
  window.location.protocol === 'tauri:' ||
  '__TAURI_INTERNALS__' in window ||
  '__TAURI__' in window;

document.documentElement.dataset.product = 'deepcode-gui';
document.documentElement.dataset.shell = isTauriShell ? 'tauri' : 'browser';

try {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <DeepCodeGuiApp />
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (error) {
  renderBootstrapError(error);
}
