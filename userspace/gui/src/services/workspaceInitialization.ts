import { activeT } from '../i18n';
import { getCurrentWorkspace, getDefaultWorkspacePath, openWorkspace } from './runtimeAdapter';

/** Initialize the Host workspace once per connection; Session owns workspace facts. */
export async function initializeHostWorkspace(): Promise<void> {
  const current = await getCurrentWorkspace();
  if (!current.ok || !current.data || current.data.current === undefined) {
    throw new Error(current.message ?? current.error ?? activeT('workspace.error.load'));
  }
  if (current.data.current !== null) return;

  const defaultPath = await getDefaultWorkspacePath();
  if (!defaultPath.ok || defaultPath.data === undefined) {
    throw new Error(defaultPath.message ?? defaultPath.error ?? activeT('workspace.error.load'));
  }
  if (defaultPath.data === null) return;

  const opened = await openWorkspace(defaultPath.data);
  if (!opened.ok || !opened.data?.workspace) {
    throw new Error(opened.message ?? opened.error ?? activeT('workspace.error.defaultOpen'));
  }
}
