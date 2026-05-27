import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';

const ROOT_EL_ID = 'root';

if (typeof performance !== 'undefined') {
  performance.mark('deepcode:react-start');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showBootstrapError(label: string, err: unknown): void {
  const root = document.getElementById(ROOT_EL_ID);
  if (!root) return;
  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}\n\n${err.stack ?? ''}`
      : String(err);

  root.innerHTML = `
    <div style="
      padding: 24px;
      color: #fff;
      background: #1f1111;
      font-family: Consolas, 'Courier New', monospace;
      font-size: 13px;
      height: 100vh;
      overflow: auto;
      box-sizing: border-box;
    ">
      <h2 style="color:#ff6b6b;margin:0 0 12px 0;">DeepCode bootstrap error (${escapeHtml(label)})</h2>
      <pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:#ddd;">${escapeHtml(message)}</pre>
      <p style="margin-top:16px;color:#888;font-size:12px;">
        The frontend failed before React could finish mounting. Copy this page content for diagnosis.
      </p>
    </div>
  `;
}

window.addEventListener('error', (event) => {
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
            background: '#1f1111',
            fontFamily: "Consolas, 'Courier New', monospace",
            fontSize: 13,
            height: '100vh',
            overflow: 'auto',
            boxSizing: 'border-box',
          }}
        >
          <h2 style={{ color: '#ff6b6b', margin: '0 0 12px 0' }}>
            DeepCode UI render error
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
            React failed while rendering the UI tree. Copy this page content for diagnosis.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById(ROOT_EL_ID);
if (!rootEl) {
  throw new Error('Cannot find #root element');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
