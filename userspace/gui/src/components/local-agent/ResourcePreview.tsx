import React, { useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { readConversationResource, type ConversationResourceReadResult } from '../../services/localAgentApi';
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
  const [resourcePreview, setResourcePreview] = useState<ResourcePreviewState | null>(null);
  const openWorkspaceResource = async (workspaceId: string, logicalPath: string) => {
    if (!sessionId) return;
    const requested = { workspaceId, logicalPath };
    setResourcePreview({ ...requested, status: 'loading' });
    try {
      const result = await readConversationResource(sessionId, workspaceId, logicalPath);
      setResourcePreview((current) => (
        current?.workspaceId === workspaceId && current.logicalPath === logicalPath
          ? { ...requested, status: 'ready', result }
          : current
      ));
    } catch (readError) {
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

  return { resourcePreview, setResourcePreview, openWorkspaceResource };
}

export function ResourcePreview({ language, preview }: { language: UiLanguage; preview: ReturnType<typeof useResourcePreview> }) {
  const { resourcePreview, setResourcePreview } = preview;
  return resourcePreview && (
    <div
      className="local-agent__resource-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setResourcePreview(null);
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
            onClick={() => setResourcePreview(null)}
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
            </>
          )}
        </div>
      </section>
    </div>
  );
}
