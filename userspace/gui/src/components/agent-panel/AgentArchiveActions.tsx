import React, { useState } from 'react';
import { getConversationArchive, readConversationArchiveFile } from '../../services/runtimeAdapter';

interface AgentArchiveActionsProps {
  sessionId?: string;
}

type ArchiveActionStatus = 'idle' | 'working' | 'done' | 'error';

const AgentArchiveActions: React.FC<AgentArchiveActionsProps> = ({ sessionId }) => {
  const [status, setStatus] = useState<ArchiveActionStatus>('idle');
  const [message, setMessage] = useState('');

  const copyArchiveFile = async (path: string) => {
    if (!sessionId) return;
    setStatus('working');
    const archive = await getConversationArchive(sessionId);
    const runId = archive.data?.archives[0]?.runId;
    const result = await readConversationArchiveFile(sessionId, { path, runId });
    if (!result.ok || !result.data) {
      setStatus('error');
      setMessage(result.message ?? result.error ?? 'archive export unavailable');
      return;
    }
    await copyText(result.data.content);
    setStatus('done');
    setMessage(path);
  };

  const copyArchivePath = async () => {
    if (!sessionId) return;
    setStatus('working');
    const archive = await getConversationArchive(sessionId);
    const archivePath = archive.data?.archives[0]?.archivePath ?? archive.data?.conversationArchiveRoot;
    if (!archive.ok || !archivePath) {
      setStatus('error');
      setMessage(archive.message ?? archive.error ?? 'archive path unavailable');
      return;
    }
    await copyText(archivePath);
    setStatus('done');
    setMessage('archive path');
  };

  return (
    <div className="agent-archive-actions" aria-label="Conversation archive actions">
      <button type="button" disabled={!sessionId || status === 'working'} onClick={() => void copyArchiveFile('exports/complete.md')}>
        复制完整对话
      </button>
      <button type="button" disabled={!sessionId || status === 'working'} onClick={() => void copyArchiveFile('exports/debug.json')}>
        复制调试包
      </button>
      <button type="button" disabled={!sessionId || status === 'working'} onClick={() => void copyArchivePath()}>
        打开归档目录
      </button>
      {status !== 'idle' && (
        <span className={`agent-archive-actions__status agent-archive-actions__status--${status}`}>
          {status === 'working' ? '处理中' : status === 'done' ? `已复制 ${message}` : message}
        </span>
      )}
    </div>
  );
};

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export default AgentArchiveActions;
