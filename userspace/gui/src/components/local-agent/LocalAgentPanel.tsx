import React, { useEffect, useMemo, useState } from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import { usePresentedCommittedContent } from '../../presentation/PresentationRuntime';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import ProjectFolderDialog from '../workspace-open-dialog/ProjectFolderDialog';
import { projectionItems, assistantDraftItems } from './conversationItems';
import { useConversationViewport } from './useConversationViewport';
import { useProjectionPolling, useProfilesUpdated } from './useProjectionPolling';
import { useAgentComposer } from './useAgentComposer';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { useConversationDisplay } from './useConversationDisplay';
import { ConversationComposer } from './ConversationComposer';
import { ConversationTranscript } from './ConversationTranscript';
import { ResourcePreview, useResourcePreview } from './ResourcePreview';
import { SessionRunStatus } from './SessionRunStatus';
import './localAgentPanel.css';

interface LocalAgentPanelProps {
  mode?: 'panel' | 'workbench';
}

const LocalAgentPanel: React.FC<LocalAgentPanelProps> = ({ mode = 'panel' }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const showReasoning = effectiveSettings['gui.showReasoning'] === true;
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const catalog = useLocalAgentStore((state) => state.catalog);
  const sessionStatuses = useLocalAgentStore((state) => state.sessionStatuses);
  const projection = useLocalAgentStore((state) => state.projection);
  const loading = useLocalAgentStore((state) => state.loading);
  const refresh = useLocalAgentStore((state) => state.refresh);
  const refreshProfiles = useLocalAgentStore((state) => state.refreshProfiles);
  const [uiActionError, setUiActionError] = useState<string | null>(null);
  useEffect(() => setUiActionError(null), [sessionId]);
  const presentation = usePresentedCommittedContent(projection, language);
  const activeSummary = catalog.sessions.find((session) => session.id === sessionId);
  const activeProject = catalog.projects.find((project) => (
    project.id === (activeSummary?.projectId ?? draftProjectId)
  ));
  const title = activeSummary?.title.trim()
    || projection?.display.creationTitle.trim()
    || t(language, 'agent.session.newTitle');
  const conversationItems = useMemo(() => projectionItems(projection), [projection]);
  const assistantDraft = projection?.assistantDraft ?? null;
  const display = useConversationDisplay(projection);
  const showChangeBar = projection?.run && !display.completedRuns.has(projection.run.runId)
    && !['failed', 'cancelled', 'indeterminate'].includes(projection.run.status);
  const draftItems = useMemo(
    () => assistantDraftItems(assistantDraft),
    [assistantDraft],
  );
  const assistantDraftLayoutKey = `${assistantDraft?.blocks.map((block) => (
    `${block.kind === 'providerHosted' ? block.outputIndex : block.streamId}:${block.kind}:${block.kind === 'providerHosted'
      ? block.status
      : block.content.length}`
  )).join('|') ?? ''}|${JSON.stringify(assistantDraft?.planPreview ?? null)}`;
  const projectionPollingActive = Boolean(
    projection?.run && ['running', 'waiting', 'releasing'].includes(projection.run.status),
  ) || Object.values(sessionStatuses).some((item) => (
    item.run && ['running', 'releasing'].includes(item.run.status)
  ));
  const timelineExtentKey = projection?.timeline.map((item) => (
    item.kind === 'toolGroup'
      ? `${item.timelineId}:${item.activityIds.length}`
      : item.timelineId
  )).join('|') ?? '';
  const hasConversationContent = conversationItems.length > 0
    || Boolean(assistantDraft)
    || Boolean(projection?.pendingInteraction)
    || Boolean(projection?.pendingApproval)
    || Boolean(projection?.pendingPlan)
    || Boolean(projection?.terminalError);
  useProfilesUpdated(refreshProfiles);
  useProjectionPolling(sessionId, projectionPollingActive, refresh);
  const viewport = useConversationViewport({
    sessionId,
    loading,
    projection,
    presentationLayoutKey: presentation.layoutKey,
    assistantDraftLayoutKey,
    timelineExtentKey,
  });
  const { bodyRef, bodyHandlers, followingLatest, scrollToLatest } = viewport;
  const composer = useAgentComposer(language, viewport.setLatestFollowMode);
  const resourcePreview = useResourcePreview(sessionId);

  return (
    <section className={`local-agent local-agent--${mode}${hasConversationContent ? '' : ' local-agent--empty'}`}>
      <header className="local-agent__header">
        <div className="local-agent__heading">
          <span className="local-agent__heading-mark"><DeepCodeShellIcon name="session" /></span>
          <div>
            <strong>{title}</strong>
            <span>{activeProject?.title ?? t(language, 'agent.chat.independent')}</span>
          </div>
        </div>
        <div className="local-agent__header-actions">
          <SessionRunStatus
            run={projection?.run ?? null}
            language={language}
            emptyLabel={!projection
              ? t(language, loading ? 'agent.chat.connecting' : 'agent.chat.new')
              : undefined}
          />
        </div>
      </header>

      <div ref={bodyRef} className="local-agent__body" aria-live="polite" {...bodyHandlers}>
        <ConversationTranscript
          completedRuns={display.completedRuns}
          onDisplayed={display.onDisplayed}
          showReasoning={showReasoning}
          language={language}
          loading={loading}
          projection={projection}
          activeProject={activeProject}
          hasConversationContent={hasConversationContent}
          conversationItems={conversationItems}
          draftItems={draftItems}
          presentation={presentation}
          viewport={viewport}
          openWorkspaceResource={resourcePreview.openWorkspaceResource}
          setUiActionError={setUiActionError}
        />
        {!followingLatest && hasConversationContent && (
          <button
            type="button"
            className="local-agent__jump-latest"
            aria-label={t(language, 'agent.jumpLatest')}
            title={t(language, 'agent.jumpLatest')}
            onClick={scrollToLatest}
          >
            <DeepCodeShellIcon name="chevronDown" />
          </button>
        )}
      </div>

      <ConversationComposer
        changeBar={showChangeBar && <FileChanges key={`${sessionId}:${projection.run!.runId}`} activities={roundChangeActivities(projection, projection.run!.runId)} compact />}
        language={language}
        composer={composer}
        uiActionError={uiActionError}
        presentationStatus={presentation.snapshot.status}
      />
      <ResourcePreview language={language} preview={resourcePreview} />
      {composer.attachmentDialogOpen && (
        <ProjectFolderDialog
          language={language}
          selectionMode="messageAttachment"
          onCancel={() => composer.setAttachmentDialogOpen(false)}
          onSelect={(absolutePath, type) => {
            void composer.selectMessageAttachment(absolutePath, type);
          }}
        />
      )}
    </section>
  );
};

export default LocalAgentPanel;
