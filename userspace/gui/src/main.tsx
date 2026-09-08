import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import {
  createGuiPresentationRegistry,
  GuiPresentationProvider,
} from './presentation/PresentationRuntime';
import { installNativeContextMenuGuard } from './utils/nativeContextMenuGuard';
import { activeT } from './i18n';

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
      <h2 style="color:#ff6b6b;margin:0 0 12px 0;">${escapeHtml(activeT('app.bootstrap.errorTitle', { label }))}</h2>
      <pre style="white-space:pre-wrap;word-break:break-word;margin:0;color:#ddd;">${escapeHtml(message)}</pre>
      <p style="margin-top:16px;color:#888;font-size:12px;">
        ${escapeHtml(activeT('app.bootstrap.errorBody'))}
      </p>
    </div>
  `;
}

window.addEventListener('error', (event) => {
  if (!event.error) return;
  console.error('[bootstrap] window.error:', event.error);
  showBootstrapError('window.error', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
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
            {activeT('app.bootstrap.renderErrorTitle')}
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
            {activeT('app.bootstrap.renderErrorBody')}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById(ROOT_EL_ID);
if (!rootEl) {
  throw new Error(activeT('app.bootstrap.rootMissing'));
}

installNativeContextMenuGuard();

const root = ReactDOM.createRoot(rootEl);
const presentationRegistry = createGuiPresentationRegistry();
let compositionDisposed = false;
const disposeComposition = () => {
  if (compositionDisposed) return;
  compositionDisposed = true;
  window.removeEventListener('pagehide', handlePageHide);
  root.unmount();
  void presentationRegistry.dispose().catch((error) => {
    console.error('[GUI presentation disposal]', error);
  });
};
const handlePageHide = (event: PageTransitionEvent) => {
  if (!event.persisted) disposeComposition();
};
window.addEventListener('pagehide', handlePageHide);
import.meta.hot?.dispose(disposeComposition);

try {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <GuiPresentationProvider registry={presentationRegistry}>
          <App />
        </GuiPresentationProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (error) {
  disposeComposition();
  showBootstrapError('root.render', error);
}
