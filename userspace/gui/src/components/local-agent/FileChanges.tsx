import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActivityProjection } from '@deepcode/protocol';
import { useConversationHost, useConversationTheme } from './ConversationHost';
import { loadConversationMonaco } from './monacoRuntime';
import { useLocalAgentStore } from '../../state/localAgentStore';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

import { changedFiles, readRoundChange, countChangedLines, type ChangeCounts, type ChangedFile } from './fileChangeSummary';
export { roundChangeActivities } from './fileChangeSummary';

export function FileChanges({ activities, compact = false }: { activities: ActivityProjection[]; compact?: boolean }) {
  const { openDiff, readChange } = useConversationHost();
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(!compact);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ChangedFile | null>(null);
  useEffect(() => { setSelected(null); setError(''); setShowAll(false); }, [sessionId]);
  useEffect(() => { setExpanded(!compact); }, [compact]);
  const all = changedFiles(activities);
  const signature = JSON.stringify(all.map((file) => [file.key, file.changes.map((entry) => [entry.recordId, entry.index])]));
  const [statistics, setStatistics] = useState<{ signature: string; files: Map<string, ChangeCounts>; error: string }>({ signature: '', files: new Map(), error: '' });
  useEffect(() => {
    if (!sessionId || !all.length) return;
    const controller = new AbortController();
    const counts = new Map<string, ChangeCounts>();
    setStatistics({ signature, files: counts, error: '' });
    void (async () => {
      for (const file of all) {
        const change = await readRoundChange(readChange, sessionId, file, controller.signal);
        if (controller.signal.aborted) return;
        counts.set(file.key, await countChangedLines(change.before, change.after, controller.signal));
        if (controller.signal.aborted) return;
        setStatistics({ signature, files: new Map(counts), error: '' });
      }
    })().catch((error: unknown) => { if (!controller.signal.aborted) setStatistics({ signature, files: new Map(counts), error: error instanceof Error ? error.message : String(error) }); });
    return () => controller.abort();
  }, [sessionId, signature, readChange]);
  const counts = statistics.signature === signature ? statistics.files : new Map<string, ChangeCounts>();
  const total = counts.size === all.length ? [...counts.values()].reduce((total, value) => ({ added: total.added + value.added, removed: total.removed + value.removed }), { added: 0, removed: 0 }) : null;
  if (!all.length || !sessionId) return null;
  const open = (file: ChangedFile, entry = file.changes.length === 1 ? file.changes[0] : undefined) => {
    if (openDiff && entry) {
      void openDiff(sessionId, entry.recordId, entry.index).catch((error: unknown) => setError(String(error)));
    } else setSelected(file);
  };
  const entries = (compact || showAll ? all : all.slice(0, 3)).map((file) => <div className="conversation-change-row" key={file.key}>
    <button type="button" className="conversation-change-file" title={file.path} onClick={() => open(file)}>
      <span>{file.path}</span>{counts.has(file.key) ? <DiffCounts counts={counts.get(file.key)!} /> : <small>{file.changes.length > 1 ? `${file.changes.length} 次修改` : ({ create: '新增', modify: '修改', delete: '删除' }[file.changes[0]!.change.kind])}</small>}
    </button>
    {openDiff && file.changes.length > 1 && <details className="conversation-change-calls"><summary>逐次查看</summary>{file.changes.map((entry, i) => <button type="button" key={`${entry.recordId}:${entry.index}`} onClick={() => open(file, entry)}>第 {i + 1} 次修改</button>)}</details>}
  </div>);
  return <section className={`conversation-changes${compact ? ' conversation-changes--compact' : ''}${expanded ? ' is-expanded' : ''}`}>
    <button type="button" className="conversation-changes-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <DeepCodeShellIcon name="compose" /><span><strong>{compact ? `${all.length} 个文件已更改` : `已修改 ${all.length} 个文件`}</strong>{!compact && <small>本轮修改</small>}</span>
      {total && <DiffCounts counts={total} />}
      <DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
    </button>
    {(compact || expanded) && <div className="conversation-change-list">{entries}
      {!compact && all.length > 3 && <button className="conversation-change-more" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}><span>{showAll ? '收起更多文件' : `再显示 ${all.length - 3} 个文件`}</span><DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" /></button>}
      {statistics.signature === signature && statistics.error && <small className="conversation-change-error" role="status">修改行数暂不可用：{statistics.error}</small>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {selected && <FileChangePreview key={`${sessionId}:${selected.key}`} sessionId={sessionId} file={selected} close={() => setSelected(null)} />}
  </section>;
}

function FileChangePreview({ sessionId, file, close }: { sessionId: string; file: ChangedFile; close(): void }) {
  const { readChange } = useConversationHost();
  const theme = useConversationTheme();
  const container = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [status, setStatus] = useState('读取本次修改…');
  const [error, setError] = useState('');
  const entry = selectedIndex === null ? null : file.changes[selectedIndex]!;
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setStatus('读取本次修改…'); setError('');
    void Promise.all([entry ? readChange(sessionId, entry.recordId, entry.index, controller.signal) : readRoundChange(readChange, sessionId, file, controller.signal), loadConversationMonaco()])
      .then(([change, monaco]) => {
        if (controller.signal.aborted || !container.current) return;
        const filename = change.path.split('/').at(-1) ?? change.path;
        const extension = filename.includes('.') ? `.${filename.split('.').at(-1)}` : '';
        const language = monaco.languages.getLanguages().find((language) => language.filenames?.includes(filename) || extension && language.extensions?.includes(extension))?.id ?? 'plaintext';
        const editor = monaco.editor.createDiffEditor(container.current, {
          readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: false, theme,
          scrollBeyondLastLine: false, minimap: { enabled: false }, fontSize: 13, lineHeight: 21,
          padding: { top: 12, bottom: 12 }, hideUnchangedRegions: { enabled: true },
        });
        const original = monaco.editor.createModel(change.before ?? '', language);
        const modified = monaco.editor.createModel(change.after ?? '', language);
        editor.setModel({ original, modified });
        const listener = editor.onDidUpdateDiff(() => {
          const changes = editor.getLineChanges();
          if (changes?.length) editor.revealLineInCenter(Math.max(1, changes[0]!.modifiedStartLineNumber));
        });
        dispose = () => { listener.dispose(); editor.dispose(); original.dispose(); modified.dispose(); };
        setStatus(change.before === null ? '新增文件' : change.after === null ? '删除文件' : selectedIndex === null ? '本轮首次修改前 → 最后修改后' : '本次操作前后内容');
      }).catch((error: unknown) => { if (!controller.signal.aborted) { setError(String(error)); setStatus('读取失败'); } });
    return () => { controller.abort(); dispose?.(); };
  }, [readChange, sessionId, file, selectedIndex, theme]);
  return createPortal(<div className="local-agent__resource-overlay conversation-diff-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <section role="dialog" aria-modal="true" aria-label={`${file.path} 修改 Diff`} className="conversation-diff-dialog">
      <header className="conversation-diff-header"><div><strong title={file.path}>{file.path}</strong><small role="status">{status}</small></div>
        <button ref={closeButton} type="button" className="conversation-diff-close" onClick={close} aria-label="关闭修改详情" title="关闭"><DeepCodeShellIcon name="close" /></button>
      </header>
      {file.changes.length > 1 && <nav className="conversation-diff-calls" aria-label="文件修改记录"><button type="button" aria-pressed={selectedIndex === null} onClick={() => setSelectedIndex(null)}>本轮汇总</button>{file.changes.map((entry, i) => <button key={`${entry.recordId}:${entry.index}`} type="button" aria-pressed={selectedIndex === i} onClick={() => setSelectedIndex(i)}>第 {i + 1} 次修改</button>)}</nav>}
      {error && <p role="alert">{error}</p>}
      <div ref={container} className="conversation-diff-editor" />
    </section>
  </div>, document.body);
}

function DiffCounts({ counts }: { counts: ChangeCounts }) {
  return <span className="conversation-diff-counts" aria-label={`新增 ${counts.added} 行，删除 ${counts.removed} 行`}><span className="is-added">+{counts.added}</span><span className="is-removed">-{counts.removed}</span></span>;
}
