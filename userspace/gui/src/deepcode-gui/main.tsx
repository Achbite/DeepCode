import React from 'react';
import ReactDOM from 'react-dom/client';
import DeepCodeGuiApp from './DeepCodeGuiApp';
import {
  createGuiPresentationRegistry,
  GuiPresentationProvider,
} from '../presentation/PresentationRuntime';
import { installNativeContextMenuGuard } from '../utils/nativeContextMenuGuard';
import { activeT } from '../i18n';

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
  shell.className = 'deepcode-gui-bootstrap-error';
  shell.innerHTML = `
    <div class="deepcode-gui-bootstrap-error__card">
      <h1>${activeT('deepcodeGui.bootstrap.startFailedTitle')}</h1>
      <p>${activeT('deepcodeGui.bootstrap.startFailedBody')}</p>
      <pre></pre>
    </div>
  `;
  const pre = shell.querySelector('pre');
  if (pre) pre.textContent = message;
  root.appendChild(shell);
}

let reactRootCreated = false;

window.addEventListener('error', (event) => {
  if (!event.error) {
    console.warn('[DeepCode-GUI browser diagnostic]', event.message);
    return;
  }
  console.error('[DeepCode-GUI runtime]', event.error ?? event.message);
  if (!reactRootCreated) renderBootstrapError(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[DeepCode-GUI runtime rejection]', event.reason);
  if (!reactRootCreated) renderBootstrapError(event.reason);
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
        <div className="deepcode-gui-bootstrap-error">
          <div className="deepcode-gui-bootstrap-error__card">
            <h1>{activeT('deepcodeGui.bootstrap.renderFailedTitle')}</h1>
            <p>{activeT('deepcodeGui.bootstrap.renderFailedBody')}</p>
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
  throw new Error(activeT('app.bootstrap.rootMissing'));
}

const isTauriShell =
  window.location.protocol === 'tauri:' ||
  '__TAURI_INTERNALS__' in window ||
  '__TAURI__' in window;

document.documentElement.dataset.product = 'deepcode-gui';
document.documentElement.dataset.shell = isTauriShell ? 'tauri' : 'browser';

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
    console.error('[DeepCode-GUI presentation disposal]', error);
  });
};
const handlePageHide = (event: PageTransitionEvent) => {
  if (!event.persisted) disposeComposition();
};
window.addEventListener('pagehide', handlePageHide);
import.meta.hot?.dispose(disposeComposition);

try {
  reactRootCreated = true;
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <GuiPresentationProvider registry={presentationRegistry}>
          <DeepCodeGuiApp />
        </GuiPresentationProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
} catch (error) {
  disposeComposition();
  if (!reactRootCreated) {
    renderBootstrapError(error);
  } else {
    console.error('[DeepCode-GUI root render]', error);
  }
}
