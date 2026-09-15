import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import ModalDialog from '../shared/ModalDialog';
import React, { useEffect, useRef, useState } from 'react';
import type { ActivityProjection } from '@deepcode/protocol';
import { useConversationHost, useConversationTheme } from './ConversationHost';
import { loadConversationMonaco } from './monacoRuntime';
import { useLocalAgentStore } from '../../state/localAgentStore';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { isBinaryFileChange } from '../../services/localAgentApi';

import { changedFiles, readRoundChange, readChangeStatistics, type FileChangeStatistics, type ChangeCounts, type ChangedFile } from './fileChangeSummary';
export { roundChangeActivities } from './fileChangeSummary';

export function FileChanges({ activities, compact = false }: { activities: ActivityProjection[]; compact?: boolean }) {
  const language = useUiLanguage();
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
        <span>{file.path}</span>{statistic?.kind === 'text' ? <DiffCounts counts={statistic.counts} /> : <small>{statistic?.kind === 'binary' ? t(language, 'changes.binaryPrefix') : ''}{file.changes.length > 1 ? t(language, 'changes.count', { count: file.changes.length }) : ({ create: t(language, 'changes.create'), modify: t(language, 'changes.modify'), delete: t(language, 'changes.delete') }[file.changes[0]!.change.kind])}</small>}
      </button>
    </div>;
  });
  return <section className={`conversation-changes${compact ? ' conversation-changes--compact' : ''}${expanded ? ' is-expanded' : ''}`}>
    <button type="button" className="conversation-changes-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <DeepCodeShellIcon name="compose" /><span><strong>{t(language, 'changes.files', { count: all.length })}</strong>{!compact && <small>{t(language, 'changes.round')}</small>}</span>
      {total && <DiffCounts counts={total} />}
      {binaryCount > 0 && <small className="conversation-change-binary-count">{t(language, 'changes.binaryCount', { count: binaryCount })}</small>}
      <DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
    </button>
    {(compact || expanded) && <div className="conversation-change-list">{entries}
      {!compact && all.length > 3 && <button className="conversation-change-more" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}><span>{showAll ? t(language, 'changes.collapse') : t(language, 'changes.more', { count: all.length - 3 })}</span><DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" /></button>}
      {statistics.signature === signature && statistics.errors.size > 0 && <details className="conversation-change-error"><summary>{t(language, 'changes.unavailable', { count: statistics.errors.size })}</summary>{[...statistics.errors].map(([path, message]) => <p key={path}><strong>{path}</strong><br />{message}</p>)}</details>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {selected && <FileChangePreview key={`${sessionId}:${selected.key}`} sessionId={sessionId} file={selected} statistic={counts.get(selected.key)} close={() => setSelected(null)} />}
  </section>;
}

function FileChangePreview({ sessionId, file, statistic, close }: { sessionId: string; file: ChangedFile; statistic?: FileChangeStatistics; close(): void }) {
  const language = useUiLanguage();
  const { readChange } = useConversationHost();
  const theme = useConversationTheme();
  const container = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState('changes.loading');
  const [error, setError] = useState('');
  const [binary, setBinary] = useState(false);
  const before = file.changes[0]!.change.before;
  const after = file.changes.at(-1)!.change.after;
  const pathEnd = file.path.lastIndexOf('/') + 1;
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setStatus('changes.loading'); setError(''); setBinary(false);
    void Promise.all([readRoundChange(readChange, sessionId, file, controller.signal), loadConversationMonaco()])
      .then(([change, monaco]) => {
        if (controller.signal.aborted || !container.current) return;
        const filename = change.path.split('/').at(-1) ?? change.path;
        const extension = filename.includes('.') ? `.${filename.split('.').at(-1)}` : '';
        const codeLanguage = monaco.languages.getLanguages().find((language) => language.filenames?.includes(filename) || extension && language.extensions?.includes(extension))?.id ?? 'plaintext';
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
        const original = monaco.editor.createModel(change.before ?? '', codeLanguage);
        const modified = monaco.editor.createModel(change.after ?? '', codeLanguage);
        editor.setModel({ original, modified });
        const listener = editor.onDidUpdateDiff(() => {
          const changes = editor.getLineChanges();
          if (changes?.length) editor.revealLineInCenter(Math.max(1, changes[0]!.modifiedStartLineNumber));
        });
        dispose = () => { listener.dispose(); editor.dispose(); original.dispose(); modified.dispose(); };
        setStatus('');
      }).catch((error: unknown) => { if (!controller.signal.aborted) {
        if (isBinaryFileChange(error)) { setBinary(true); setStatus('changes.binary'); }
        else { setError(String(error)); setStatus('changes.failed'); }
      } });
    return () => { controller.abort(); dispose?.(); };
  }, [readChange, sessionId, file, theme]);
  return <ModalDialog className="conversation-diff-overlay" onClose={close} aria-label={file.path}>
    <section aria-label={t(language, 'changes.diffTitle', { path: file.path })} className="conversation-diff-dialog">
      <header className="conversation-diff-header">
        <DeepCodeShellIcon name="artifact" />
        <div className="conversation-diff-title"><div className="conversation-diff-path" title={file.path}><span>{file.path.slice(0, pathEnd)}</span><strong>{file.path.slice(pathEnd)}</strong></div>{status && <small role="status">{t(language, status)}</small>}</div>
        {statistic?.kind === 'text' && <DiffCounts counts={statistic.counts} />}
        <button ref={closeButton} type="button" className="conversation-diff-close" onClick={close} aria-label={t(language, 'changes.close')} title={t(language, 'changes.closeTitle')}><DeepCodeShellIcon name="close" /></button>
      </header>
      {error && <p role="alert">{error}</p>}
      {binary && <div className="conversation-diff-binary">{t(language, 'changes.binaryDescription')}<small>{before.exists ? t(language, 'changes.beforeSize', { size: before.sizeBytes ?? t(language, 'changes.unknown') }) : t(language, 'changes.beforeAbsent')} · {after.exists ? t(language, 'changes.afterSize', { size: after.sizeBytes ?? t(language, 'changes.unknown') }) : t(language, 'changes.afterAbsent')}</small></div>}
      <div ref={container} className="conversation-diff-editor" />
    </section>
  </ModalDialog>;
}

function DiffCounts({ counts }: { counts: ChangeCounts }) {
  const language = useUiLanguage();
  return <span className="conversation-diff-counts" aria-label={t(language, 'changes.lineCounts', { added: counts.added, removed: counts.removed })}><span className="is-added">+{counts.added}</span><span className="is-removed">-{counts.removed}</span></span>;
}
