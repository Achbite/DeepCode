import { useConversationHost } from './ConversationHost';
import React, { useEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { type ConversationResourceReadResult } from '../../services/localAgentApi';
import { formatBytes } from './conversationFormatting';

type ResourcePreviewState =
  | {
      workspaceId: string;
      logicalPath: string;
      status: 'loading';
    }
  | {
      workspaceId: string;
      logicalPath: string;
      status: 'ready';
      result: ConversationResourceReadResult;
    }
  | {
      workspaceId: string;
      logicalPath: string;
      status: 'error';
      error: string;
    };

export function useResourcePreview(sessionId: string | null) {
  const { readResource: readConversationResource, openFile } = useConversationHost();
  const [resourcePreview, setResourcePreview] = useState<ResourcePreviewState | null>(null);
  const readController = useRef<AbortController | null>(null);
  const lifecycle = useRef({ sessionId, version: 0 });
  if (lifecycle.current.sessionId !== sessionId) lifecycle.current = { sessionId, version: lifecycle.current.version + 1 };
  useEffect(() => { setResourcePreview(null); return () => { lifecycle.current.version += 1; readController.current?.abort(); }; }, [sessionId]);
  const openWorkspaceResource = async (workspaceId: string, logicalPath: string, startByte?: number) => {
    if (!sessionId) return;
    const version = ++lifecycle.current.version;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const requested = { workspaceId, logicalPath };
    setResourcePreview({ ...requested, status: 'loading' });
    try {
      if (openFile && startByte === undefined) {
        await openFile(sessionId, workspaceId, logicalPath);
        if (version === lifecycle.current.version) setResourcePreview(null);
        return;
      }
      const result = await readConversationResource(sessionId, workspaceId, logicalPath, controller.signal, startByte);
      if (version !== lifecycle.current.version) return;
      setResourcePreview((current) => (
        current?.workspaceId === workspaceId && current.logicalPath === logicalPath
          ? { ...requested, status: 'ready', result }
          : current
      ));
    } catch (readError) {
      if (version !== lifecycle.current.version) return;
      setResourcePreview((current) => (
        current?.workspaceId === workspaceId && current.logicalPath === logicalPath
          ? {
              ...requested,
              status: 'error',
              error: readError instanceof Error ? readError.message : String(readError),
            }
          : current
      ));
    }
  };

  const closeResourcePreview = () => { lifecycle.current.version += 1; readController.current?.abort(); setResourcePreview(null); };
  return { resourcePreview, closeResourcePreview, openWorkspaceResource };
}

export function ResourcePreview({ language, preview }: { language: UiLanguage; preview: ReturnType<typeof useResourcePreview> }) {
  const { resourcePreview, closeResourcePreview } = preview;
  return resourcePreview && (
    <div
      className="local-agent__resource-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeResourcePreview();
      }}
    >
      <section
        className="local-agent__resource-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(language, 'agent.resource.preview')}
      >
        <header>
          <div>
            <strong>{resourcePreview.logicalPath}</strong>
            <span>{t(language, 'agent.resource.readOnly')}</span>
          </div>
          <button
            type="button"
            aria-label={t(language, 'window.close')}
            onClick={closeResourcePreview}
          >×</button>
        </header>
        <div className="local-agent__resource-body">
          {resourcePreview.status === 'loading' ? (
            <p>{t(language, 'agent.resource.reading')}</p>
          ) : resourcePreview.status === 'error' ? (
            <p className="local-agent__resource-error">{resourcePreview.error}</p>
          ) : (
            <>
              <div className="local-agent__resource-meta">
                <span>{formatBytes(resourcePreview.result.sizeBytes, language)}</span>
                <span>
                  {t(language, 'agent.resource.lines', {
                    start: resourcePreview.result.startLine,
                    end: resourcePreview.result.endLine,
                  })}
                </span>
              </div>
              <pre>{resourcePreview.result.content}</pre>
              {resourcePreview.result.truncated && <span>当前为部分内容。</span>}
              {resourcePreview.result.nextByte !== undefined && <button type="button" onClick={() => void preview.openWorkspaceResource(resourcePreview.workspaceId, resourcePreview.logicalPath, resourcePreview.result.nextByte)}>读取下一段</button>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
