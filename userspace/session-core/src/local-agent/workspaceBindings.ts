import type { FilesystemReference, WorkspaceBindingDisplay } from '@deepcode/protocol';

/** Append admitted immutable file snapshots without renumbering existing handles. */
export function appendInputFileBindings(
  bindings: readonly WorkspaceBindingDisplay[],
  references: readonly FilesystemReference[] = [],
): WorkspaceBindingDisplay[] {
  const result = bindings.map(binding => ({ ...binding }));
  const known = new Set(result.map(binding => binding.workspaceId));
  for (const reference of references) {
    if (reference.kind !== 'file' || known.has(reference.workspaceId)) continue;
    known.add(reference.workspaceId);
    result.push({ workspaceId: reference.workspaceId, displayName: reference.displayName });
  }
  return result;
}
