import React, { useState } from 'react';
import type { LocalAgentError, SessionProjection } from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';

function ErrorDetails({ error, language }: { error: LocalAgentError; language: UiLanguage }) {
  const d = error.diagnostics;
  return <details className="local-agent__error-details">
    <summary>{language === 'zh-CN' ? '诊断信息' : 'Diagnostics'}</summary>
    <code>{error.code}</code>
    {d && <>
      <p>{d.source} · {d.phase} · {d.category}</p>
      <dl>{(['isConnect', 'isTimeout', 'isBody'] as const).map((key) => d[key] === undefined ? null : <React.Fragment key={key}><dt>{key}</dt><dd>{String(d[key])}</dd></React.Fragment>)}</dl>
      {d.stopReason && <p>{d.stopReason}</p>}
      {d.causes.length > 0 && <ol>{d.causes.map((cause, index) => <li key={index}>{cause.message}{cause.kind && ` (${cause.kind})`}{cause.osCode !== undefined && ` [OS ${cause.osCode}]`}</li>)}</ol>}
      {d.archivePath && <p>{d.archivePath}</p>}
      {d.secondary?.map((secondary, index) => <p key={index}>{secondary.code}: {secondary.message}</p>)}
    </>}
  </details>;
}

export function ProviderRetryStatus({ projection, language }: { projection: SessionProjection; language: UiLanguage }) {
  const attempt = projection.providerAttempts?.at(-1);
  if (projection.run?.status !== 'running' || attempt?.phase !== 'retryWaiting') return null;
  return <aside className="local-agent__retry-status" role="status">
    <p>{language === 'zh-CN' ? `网络连接中断，正在等待第 ${attempt.attempt + 1}/5 次尝试。` : `Connection interrupted. Waiting for attempt ${attempt.attempt + 1}/5.`}</p>
    {attempt.error && <ErrorDetails error={attempt.error} language={language} />}
  </aside>;
}

export function RunFailureDetails({ projection, language, onError }: {
  projection: SessionProjection; language: UiLanguage; onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const error = projection.terminalError ?? projection.failureSnapshot?.error;
  if (!error) return null;
  const zh = language === 'zh-CN';
  const snapshot = projection.failureSnapshot;
  const cancelled = error.diagnostics?.stopReason === 'user_cancelled';
  const continueTask = async (inNewSession: boolean) => {
    setBusy(true);
    try {
      const store = useLocalAgentStore.getState();
      if (store.sessionId !== projection.sessionId) return;
      if (inNewSession) {
        const projectId = store.catalog.sessions.find((item) => item.id === projection.sessionId)?.projectId;
        store.startNewSession(projectId ?? null);
      }
      await useLocalAgentStore.getState().sendMessage(inNewSession
        ? `接手来源会话 ${projection.sessionId}。先通过 session 工具读取该会话的目标、计划和相关工具结果，确认已完成事实后继续未完成的任务。`
        : '继续当前任务。请先核对已经执行的工具结果和未完成计划，再继续处理。');
      onError(null);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <article className="local-agent__terminal-error">
    <p>{cancelled ? (zh ? '已收到取消请求，本次生成未完成。' : 'Cancelled. This generation did not finish.') : error.code === 'plan_incomplete'
      ? (zh ? '本次运行已停止，计划仍有未完成的步骤。' : 'The run stopped with unfinished plan steps.') : error.message}</p>
    <ErrorDetails error={error} language={language} />
    {snapshot && <details><summary>{zh ? '失败时的状态' : 'State at failure'}</summary>
      <p>{zh ? `会话版本 ${snapshot.revision} · ${snapshot.phase}` : `Session revision ${snapshot.revision} · ${snapshot.phase}`}</p>
      <p>{zh ? `Provider 尝试 ${snapshot.providerAttemptIds.length} 次，已记录工具结果 ${snapshot.toolRecordIds.length} 项，待确认调用 ${snapshot.pendingCallIds.length} 项。` : `${snapshot.providerAttemptIds.length} provider attempts, ${snapshot.toolRecordIds.length} tool records, ${snapshot.pendingCallIds.length} pending calls.`}</p>
      {snapshot.providerRequestId && <code>{snapshot.providerRequestId}</code>}
      {projection.providerAttempts?.map((attempt) => <details key={attempt.providerAttemptId}><summary>{attempt.attempt}/5 · {attempt.phase}</summary><code>{attempt.providerAttemptId}</code>{attempt.error && <ErrorDetails error={attempt.error} language={language} />}</details>)}
    </details>}
    <div className="local-agent__recovery-actions">
      <button type="button" disabled={busy || !projection.run || ['running', 'waiting', 'finishing'].includes(projection.run.status)} onClick={() => void continueTask(false)}>{zh ? '在原会话继续' : 'Continue here'}</button>
      <button type="button" disabled={busy} onClick={() => void continueTask(true)}>{zh ? '新会话接手' : 'Continue in a new session'}</button>
    </div>
  </article>;
}
