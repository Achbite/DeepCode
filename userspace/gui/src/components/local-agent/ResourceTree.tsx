import { useEffect, useRef, useState } from 'react';
import { asyncDataLoaderFeature, hotkeysCoreFeature, type ItemInstance } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { useConversationHost } from './ConversationHost';
import { resourceKey, type ResourceEntry } from '../../services/conversationResources';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { UiLanguage } from '../../i18n';
import type { ReaderTarget } from './readerState';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

type Node = { name: string; parentId?: string; entry?: ResourceEntry; error?: string };

export function ResourceTree({ sessionId, language, openTarget }: { sessionId: string; language: UiLanguage; openTarget(target: ReaderTarget): void }) {
  const { resources } = useConversationHost();
  const chinese = language === 'zh-CN';
  const [filter, setFilter] = useState('');
  const [showRuntime, setShowRuntime] = useState(false);
  const [watchError, setWatchError] = useState('');
  const nodes = useRef(new Map<string, Node>([['root', { name: chinese ? '文件' : 'Files' }]]));
  const lifetime = useRef<AbortController | undefined>(undefined);
  const displayedItems = useRef<ItemInstance<Node>[]>([]);
  const focusItem = (index: number) => {
    displayedItems.current[index]?.setFocused();
    tree.updateDomFocus();
  };
  const moveFocus = (offset: number) => {
    const index = displayedItems.current.findIndex(item => item.isFocused());
    focusItem(Math.max(0, Math.min(index + offset, displayedItems.current.length - 1)));
  };
  const projectionKey = useLocalAgentStore(state => JSON.stringify([
    state.projection?.workspaceBindings, state.projection?.shellAuthorizations,
  ]));
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const open = (entry?: ResourceEntry) => {
    if (entry?.kind === 'file') openTarget({ kind: 'resource', resource: entry.resource, name: entry.name });
  };
  const tree = useTree<Node>({
    rootItemId: 'root',
    getItemName: item => item.getItemData().name,
    isItemFolder: item => item.getId() === 'root' || item.getItemData().entry?.kind === 'directory',
    onPrimaryAction: item => open(item.getItemData().entry),
    createLoadingItemData: () => ({ name: chinese ? '正在读取…' : 'Loading…' }),
    hotkeys: {
      focusNextItem: { hotkey: 'ArrowDown', handler: () => moveFocus(1) },
      focusPreviousItem: { hotkey: 'ArrowUp', handler: () => moveFocus(-1) },
      focusFirstItem: { hotkey: 'Home', handler: () => focusItem(0) },
      focusLastItem: { hotkey: 'End', handler: () => focusItem(displayedItems.current.length - 1) },
      expandOrDown: { hotkey: 'ArrowRight', handler: () => {
        const item = tree.getFocusedItem();
        if (item.isExpanded() || !item.isFolder()) moveFocus(1);
        else item.expand();
      } },
    },
    dataLoader: {
      getItem: id => {
        const node = nodes.current.get(id);
        if (!node) throw new Error('resource_tree_item_missing');
        return node;
      },
      getChildrenWithData: async id => {
        try {
          const entry = nodes.current.get(id)?.entry;
          const children = id === 'root'
            ? await resources.listResourceRoots(sessionId, lifetime.current?.signal)
            : await resources.listResourceDirectory(sessionId, entry!.resource, lifetime.current?.signal);
          return children.map(child => {
            const childId = resourceKey(child.resource);
            const category = child.category && ({ project: chinese ? '项目' : 'Project', session: chinese ? '会话文件' : 'Session files', resource: chinese ? '已授权资源' : 'Granted resource' }[child.category]);
            const data = { entry: child, parentId: id, name: child.category === 'session' ? category! : category ? `${category} · ${child.name}` : child.name, error: child.error };
            nodes.current.set(childId, data);
            return { id: childId, data };
          });
        } catch (error) {
          if (lifetime.current?.signal.aborted) return [];
          const data = { name: String(error), error: String(error) };
          nodes.current.set(`${id}:error`, data);
          return [{ id: `${id}:error`, data }];
        }
      },
    },
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });
  useEffect(() => { void tree.getRootItem().invalidateChildrenIds(true); }, [projectionKey, tree]);
  const items = tree.getItems();
  const runtimeRoots = items.filter(item => item.getItemData().entry?.category === 'session').map(item => item.getId());
  const hidden = new Set<string>();
  const visible = items.filter(item => {
    const entry = item.getItemData().entry;
    if (!showRuntime && entry?.resource.logicalPath === 'home' && runtimeRoots.includes(item.getParent()?.getId() ?? '')) hidden.add(item.getId());
    return ![...hidden].some(id => item.getId() === id || item.isDescendentOf(id));
  });
  const matched = new Set<string>();
  for (const [id, node] of nodes.current) {
    if (!node.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) continue;
    for (let ancestor: string | undefined = id; ancestor; ancestor = nodes.current.get(ancestor)?.parentId) matched.add(ancestor);
  }
  const displayed = visible.filter(item => !filter || matched.has(item.getId()));
  displayedItems.current = displayed;
  const watched = displayed.filter(item => item.isExpanded() && item.getItemData().entry?.kind === 'directory');
  const watchKey = JSON.stringify(watched.map(item => item.getId()).sort());
  useEffect(() => {
    const ids = JSON.parse(watchKey) as string[];
    if (!ids.length) return;
    const controller = new AbortController();
    setWatchError('');
    void resources.watchResources(sessionId, ids.map(id => nodes.current.get(id)!.entry!.resource), controller.signal, indices => {
      for (const index of indices) void tree.getItemInstance(ids[index]).invalidateChildrenIds(true);
    }).catch(error => { if (!controller.signal.aborted) setWatchError(String(error)); });
    return () => controller.abort();
  }, [sessionId, watchKey, tree, resources]);
  return <aside className="resource-tree" aria-label={chinese ? '文件树' : 'File tree'}>
    <label className="resource-tree__filter"><DeepCodeShellIcon name="search" /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={chinese ? '筛选已加载文件…' : 'Filter loaded files…'} aria-label={chinese ? '筛选文件' : 'Filter files'} /></label>
    {watchError && <p className="local-agent__resource-error" role="alert">{watchError}</p>}
    <div className="resource-tree__items" {...tree.getContainerProps(chinese ? '文件' : 'Files')}>
      {displayed.map(item => {
        const data = item.getItemData();
        return <button key={item.getId()} {...item.getProps()} type="button" title={data.error ?? data.entry?.resource.logicalPath ?? data.name}
          className={`resource-tree__item${item.isFocused() ? ' is-selected' : ''}${data.entry?.category ? ' is-root' : ''}`}
          style={{ paddingLeft: 8 + item.getItemMeta().level * 12 }}>
          <DeepCodeShellIcon name={item.isFolder() ? (item.isExpanded() ? 'chevronDown' : 'chevronRight') : 'artifact'} />
          <span className={data.error ? 'local-agent__resource-error' : ''}>{data.name}</span>
        </button>;
      })}
    </div>
    <label className="resource-tree__runtime"><input type="checkbox" checked={showRuntime} onChange={event => setShowRuntime(event.target.checked)} />{chinese ? '显示运行环境文件' : 'Show runtime files'}</label>
  </aside>;
}
