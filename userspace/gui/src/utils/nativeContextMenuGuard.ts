type ContextMenuGuardOptions = {
  allowSelector?: string;
};

function isTauriShell(): boolean {
  return (
    window.location.protocol === 'tauri:' ||
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window
  );
}

export function installNativeContextMenuGuard(
  options: ContextMenuGuardOptions = {}
): () => void {
  if (!isTauriShell()) return () => undefined;

  const allowSelector = options.allowSelector ?? '[data-native-context-menu="allow"]';
  const onContextMenu = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(allowSelector)) return;
    event.preventDefault();
  };

  document.addEventListener('contextmenu', onContextMenu);
  return () => document.removeEventListener('contextmenu', onContextMenu);
}
