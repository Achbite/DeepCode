import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActivityProjection } from '@deepcode/protocol';
import { useConversationHost, useConversationTheme } from './ConversationHost';
import { loadConversationMonaco } from './monacoRuntime';
import { useLocalAgentStore } from '../../state/localAgentStore';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { isBinaryFileChange } from '../../services/localAgentApi';

import { changedFiles, readRoundChange, readChangeStatistics, type FileChangeStatistics, type ChangeCounts, type ChangedFile } from './fileChangeSummary';
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
  const [statistics, setStatistics] = useState<{ signature: string; files: Map<string, FileChangeStatistics>; errors: Map<string, string> }>({ signature: '', files: new Map(), errors: new Map() });
  useEffect(() => {
    if (!sessionId || !all.length) return;
    const controller = new AbortController();
    const files = new Map<string, FileChangeStatistics>();
    const errors = new Map<string, string>();
    setStatistics({ signature, files, errors });
    void (async () => {
      for (const file of all) {
        try {
          files.set(file.key, await readChangeStatistics(readChange, sessionId, file, controller.signal));
        } catch (error) {
          if (controller.signal.aborted) return;
          errors.set(file.path, error instanceof Error ? error.message : String(error));
        }
        if (controller.signal.aborted) return;
        setStatistics({ signature, files: new Map(files), errors: new Map(errors) });
      }
    })();
    return () => controller.abort();
  }, [sessionId, signature, readChange]);
  const counts = statistics.signature === signature ? statistics.files : new Map<string, FileChangeStatistics>();
  const binaryCount = [...counts.values()].filter((value) => value.kind === 'binary').length;
  const total = counts.size === all.length && counts.size > binaryCount ? [...counts.values()].reduce((total, value) => value.kind === 'text' ? ({ added: total.added + value.counts.added, removed: total.removed + value.counts.removed }) : total, { added: 0, removed: 0 }) : null;
  if (!all.length || !sessionId) return null;
  const open = (file: ChangedFile) => {
    const entry = file.changes.length === 1 ? file.changes[0] : undefined;
    if (openDiff && entry) {
      void openDiff(sessionId, entry.recordId, entry.index).catch((error: unknown) => setError(String(error)));
    } else setSelected(file);
  };
  const entries = (compact || showAll ? all : all.slice(0, 3)).map((file) => {
    const statistic = counts.get(file.key);
    return <div className="conversation-change-row" key={file.key}>
      <button type="button" className="conversation-change-file" title={file.path} onClick={() => open(file)}>
        <span>{file.path}</span>{statistic?.kind === 'text' ? <DiffCounts counts={statistic.counts} /> : <small>{statistic?.kind === 'binary' ? '二进制 · ' : ''}{file.changes.length > 1 ? `${file.changes.length} 次修改` : ({ create: '新增', modify: '修改', delete: '删除' }[file.changes[0]!.change.kind])}</small>}
      </button>
    </div>;
  });
  return <section className={`conversation-changes${compact ? ' conversation-changes--compact' : ''}${expanded ? ' is-expanded' : ''}`}>
    <button type="button" className="conversation-changes-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <DeepCodeShellIcon name="compose" /><span><strong>{compact ? `${all.length} 个文件已更改` : `已修改 ${all.length} 个文件`}</strong>{!compact && <small>本轮修改</small>}</span>
      {total && <DiffCounts counts={total} />}
      {binaryCount > 0 && <small className="conversation-change-binary-count">另含 {binaryCount} 个二进制文件</small>}
      <DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
    </button>
    {(compact || expanded) && <div className="conversation-change-list">{entries}
      {!compact && all.length > 3 && <button className="conversation-change-more" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}><span>{showAll ? '收起更多文件' : `再显示 ${all.length - 3} 个文件`}</span><DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" /></button>}
      {statistics.signature === signature && statistics.errors.size > 0 && <details className="conversation-change-error"><summary>{statistics.errors.size} 个文件的行数暂不可用</summary>{[...statistics.errors].map(([path, message]) => <p key={path}><strong>{path}</strong><br />{message}</p>)}</details>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {selected && <FileChangePreview key={`${sessionId}:${selected.key}`} sessionId={sessionId} file={selected} statistic={counts.get(selected.key)} close={() => setSelected(null)} />}
  </section>;
}

function FileChangePreview({ sessionId, file, statistic, close }: { sessionId: string; file: ChangedFile; statistic?: FileChangeStatistics; close(): void }) {
  const { readChange } = useConversationHost();
  const theme = useConversationTheme();
  const container = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState('读取修改内容…');
  const [error, setError] = useState('');
  const [binary, setBinary] = useState(false);
  const before = file.changes[0]!.change.before;
  const after = file.changes.at(-1)!.change.after;
  const pathEnd = file.path.lastIndexOf('/') + 1;
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setStatus('读取修改内容…'); setError(''); setBinary(false);
    void Promise.all([readRoundChange(readChange, sessionId, file, controller.signal), loadConversationMonaco()])
      .then(([change, monaco]) => {
        if (controller.signal.aborted || !container.current) return;
        const filename = change.path.split('/').at(-1) ?? change.path;
        const extension = filename.includes('.') ? `.${filename.split('.').at(-1)}` : '';
        const language = monaco.languages.getLanguages().find((language) => language.filenames?.includes(filename) || extension && language.extensions?.includes(extension))?.id ?? 'plaintext';
        const diffTheme = `deepcode-diff-${theme}`;
        const dark = theme === 'vs-dark';
        monaco.editor.defineTheme(diffTheme, {
          base: theme, inherit: true, rules: [], colors: {
            'diffEditor.insertedLineBackground': dark ? '#1d382a' : '#e7f3e9',
            'diffEditor.removedLineBackground': dark ? '#402627' : '#fbe9e7',
            'diffEditor.insertedTextBackground': '#00000000',
            'diffEditor.removedTextBackground': '#00000000',
            'diffEditorGutter.insertedLineBackground': dark ? '#1d382a' : '#e7f3e9',
            'diffEditorGutter.removedLineBackground': dark ? '#402627' : '#fbe9e7',
            'diffEditor.unchangedRegionBackground': dark ? '#252830' : '#f4f4f5',
            'diffEditor.unchangedRegionForeground': dark ? '#a8acb5' : '#65676c',
            'diffEditor.unchangedCodeBackground': '#00000000',
          },
        });
        const editor = monaco.editor.createDiffEditor(container.current, {
          readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: false, theme: diffTheme,
          scrollBeyondLastLine: false, minimap: { enabled: false }, fontSize: 13, lineHeight: 25,
          fontFamily: 'var(--dc-font-mono)', wordWrap: 'on', diffWordWrap: 'on',
          ignoreTrimWhitespace: false, renderOverviewRuler: false, renderLineHighlight: 'none',
          padding: { top: 8, bottom: 12 },
          hideUnchangedRegions: { enabled: true, contextLineCount: 2, minimumLineCount: 3, revealLineCount: 20 },
        });
        const original = monaco.editor.createModel(change.before ?? '', language);
        const modified = monaco.editor.createModel(change.after ?? '', language);
        editor.setModel({ original, modified });
        const listener = editor.onDidUpdateDiff(() => {
          const changes = editor.getLineChanges();
          if (changes?.length) editor.revealLineInCenter(Math.max(1, changes[0]!.modifiedStartLineNumber));
        });
        dispose = () => { listener.dispose(); editor.dispose(); original.dispose(); modified.dispose(); };
        setStatus('');
      }).catch((error: unknown) => { if (!controller.signal.aborted) {
        if (isBinaryFileChange(error)) { setBinary(true); setStatus('二进制文件'); }
        else { setError(String(error)); setStatus('读取失败'); }
      } });
    return () => { controller.abort(); dispose?.(); };
  }, [readChange, sessionId, file, theme]);
  return createPortal(<div className="local-agent__resource-overlay conversation-diff-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <section role="dialog" aria-modal="true" aria-label={`${file.path} 修改 Diff`} className="conversation-diff-dialog">
      <header className="conversation-diff-header">
        <DeepCodeShellIcon name="artifact" />
        <div className="conversation-diff-title"><div className="conversation-diff-path" title={file.path}><span>{file.path.slice(0, pathEnd)}</span><strong>{file.path.slice(pathEnd)}</strong></div>{status && <small role="status">{status}</small>}</div>
        {statistic?.kind === 'text' && <DiffCounts counts={statistic.counts} />}
        <button ref={closeButton} type="button" className="conversation-diff-close" onClick={close} aria-label="关闭修改详情" title="关闭"><DeepCodeShellIcon name="close" /></button>
      </header>
      {error && <p role="alert">{error}</p>}
      {binary && <div className="conversation-diff-binary">二进制文件不提供文本行数和逐行对比。<small>{before.exists ? `修改前 ${before.sizeBytes ?? '未知'} 字节` : '修改前不存在'} · {after.exists ? `修改后 ${after.sizeBytes ?? '未知'} 字节` : '修改后不存在'}</small></div>}
      <div ref={container} className="conversation-diff-editor" />
    </section>
  </div>, document.body);
}

function DiffCounts({ counts }: { counts: ChangeCounts }) {
  return <span className="conversation-diff-counts" aria-label={`新增 ${counts.added} 行，删除 ${counts.removed} 行`}><span className="is-added">+{counts.added}</span><span className="is-removed">-{counts.removed}</span></span>;
}
