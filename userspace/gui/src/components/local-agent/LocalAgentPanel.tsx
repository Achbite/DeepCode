import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ActivityProjection,
  AssistantDraftBlockProjection,
  MessageFeedback,
  PlanResponse,
  PluginSelectionInput,
  ProviderHostedActivityProjection,
  RunProjection,
  SessionProjection,
} from '@deepcode/protocol';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../../deepcode-gui/layout/DeepCodeShellIcon';
import ProjectFolderDialog from '../../deepcode-gui/layout/ProjectFolderDialog';
import SessionModelSelector from '../../deepcode-gui/panel/SessionModelSelector';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import { usePresentedCommittedContent } from '../../presentation/PresentationRuntime';
import { BufferedMarkdown } from './BufferedMarkdown';
import PlanCard from './PlanCard';
import { shouldOfferFocusCommand, shouldSubmitComposerKey } from './composerKeyboard';
import {
  readConversationResource,
  type ConversationResourceReadResult,
} from '../../services/localAgentApi';
import './localAgentPanel.css';

interface LocalAgentPanelProps {
  mode?: 'panel' | 'workbench';
}

interface PendingFilesystemPath {
  path: string;
  kind: 'file' | 'directory';
}

interface SessionViewport {
  mode: 'following' | 'detached';
  scrollTop: number;
}

interface ComposerState {
  draft: string;
  filesystemPaths: PendingFilesystemPath[];
  pluginSelections: PluginSelectionInput[];
  selectionStart: number;
  selectionEnd: number;
  focused: boolean;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (window.navigator.clipboard?.writeText) {
    await window.navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard_copy_failed');
}

const LocalAgentPanel: React.FC<LocalAgentPanelProps> = ({ mode = 'panel' }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const runtimeEffectiveSettings = useSettingsStore((state) => state.runtimeEffectiveSettings);
  const settingsPendingNextRunActivation = useSettingsStore(
    (state) => state.pendingNextRunActivation,
  );
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const catalog = useLocalAgentStore((state) => state.catalog);
  const pluginCatalog = useLocalAgentStore((state) => state.pluginCatalog);
  const profiles = useLocalAgentStore((state) => state.profiles);
  const selectedProfileId = useLocalAgentStore((state) => state.selectedProfileId);
  const projection = useLocalAgentStore((state) => state.projection);
  const pendingInteraction = projection?.pendingInteraction ?? null;
  const pendingApproval = projection?.pendingApproval ?? null;
  const pendingPlan = projection?.pendingPlan ?? null;
  const composerViewKey = sessionId ?? `new:${draftProjectId ?? 'independent'}`;
  const composerModeKey = pendingPlan
    ? `plan:${pendingPlan.planId}:${pendingPlan.revision}`
    : pendingInteraction
      ? `interaction:${pendingInteraction.interactionId}`
      : pendingApproval
        ? `approval:${pendingApproval.approvalId}`
        : 'normal';
  const composerStateKey = `${composerViewKey}\u0000${composerModeKey}`;
  const presentation = usePresentedCommittedContent(projection, language);
  const loading = useLocalAgentStore((state) => state.loading);
  const submitting = useLocalAgentStore((state) => state.submitting);
  const catalogBusy = useLocalAgentStore((state) => state.catalogBusy);
  const error = useLocalAgentStore((state) => state.error);
  const refreshProfiles = useLocalAgentStore((state) => state.refreshProfiles);
  const refresh = useLocalAgentStore((state) => state.refresh);
  const sendMessage = useLocalAgentStore((state) => state.sendMessage);
  const focusContext = useLocalAgentStore((state) => state.focusContext);
  const setMessageFeedback = useLocalAgentStore((state) => state.setMessageFeedback);
  const respondInteraction = useLocalAgentStore((state) => state.respondInteraction);
  const respondApproval = useLocalAgentStore((state) => state.respondApproval);
  const respondPlan = useLocalAgentStore((state) => state.respondPlan);
  const cancelRun = useLocalAgentStore((state) => state.cancelRun);
  const selectProfile = useLocalAgentStore((state) => state.selectProfile);
  const [draft, setDraft] = useState('');
  const [pendingFilesystemPaths, setPendingFilesystemPaths] = useState<
    PendingFilesystemPath[]
  >([]);
  const [pluginSelections, setPluginSelections] = useState<PluginSelectionInput[]>([]);
  const [pluginPickerOpen, setPluginPickerOpen] = useState(false);
  const [pluginQuery, setPluginQuery] = useState('');
  const [pluginTriggerStart, setPluginTriggerStart] = useState<number | null>(null);
  const [pluginActiveIndex, setPluginActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [resourcePreview, setResourcePreview] = useState<ResourcePreviewState | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [uiActionError, setUiActionError] = useState<string | null>(null);
  const [, setProviderStreamCompletionRevision] = useState(0);

  useEffect(() => {
    const handleProfilesUpdated = () => {
      void refreshProfiles();
    };
    window.addEventListener('deepcode:llm-profiles-updated', handleProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', handleProfilesUpdated);
  }, [refreshProfiles]);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const attachmentControlRef = useRef<HTMLDivElement | null>(null);
  const pluginPickerRef = useRef<HTMLDivElement | null>(null);
  const permissionControlRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerStatesRef = useRef(new Map<string, ComposerState>());
  const activeComposerStateKeyRef = useRef(composerStateKey);
  const pendingComposerRestoreRef = useRef<{
    key: string;
    state: ComposerState;
  } | null>(null);
  const compositionActiveRef = useRef(false);
  const compositionCommitPendingRef = useRef(false);
  const compositionGuardFrameRef = useRef<number | null>(null);
  const activeViewRef = useRef<string | null>(sessionId);
  const sessionViewportsRef = useRef(new Map<string, SessionViewport>());
  const pendingViewportRestoreRef = useRef<string | null>(null);
  const providerStreamProgressRef = useRef(new Map<string, number>());
  const transitioningProviderStreamsRef = useRef(new Set<string>());
  const followingLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  const touchScrollActiveRef = useRef(false);
  const pointerScrollActiveRef = useRef(false);
  const transientUserScrollRef = useRef(false);
  const transientUserScrollFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const viewportRestoreFrameRef = useRef<number | null>(null);
  const detachedViewportFrameRef = useRef<number | null>(null);
  const activeSummary = catalog.sessions.find((session) => session.id === sessionId);
  const activeProject = catalog.projects.find((project) => (
    project.id === (activeSummary?.projectId ?? draftProjectId)
  ));
  const title = activeSummary?.title.trim()
    || projection?.display.creationTitle.trim()
    || t(language, 'agent.session.newTitle');
  const conversationItems = useMemo(() => projectionItems(projection), [projection]);
  const assistantDraft = projection?.assistantDraft ?? null;
  const legacyAssistantDraftStreamIdentity = projection && assistantDraft?.content
    ? providerStreamIdentity(projection.sessionId, assistantDraft.runId, assistantDraft.turnId)
    : null;
  const orderedAssistantDraftItems = useMemo(
    () => assistantDraftItems(assistantDraft),
    [assistantDraft],
  );
  const assistantDraftLayoutKey = assistantDraft
    ? `${assistantDraft.content.length}:${assistantDraft.orderedBlocks?.map((block) => (
        `${block.outputIndex}:${block.kind}:${block.kind === 'providerHosted'
          ? block.status
          : block.content.length}`
      )).join('|') ?? ''}`
    : '';
  const projectionPollingActive = Boolean(
    projection?.run && ['running', 'waiting', 'releasing'].includes(projection.run.status),
  );
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
  const latestRunComposition = useMemo(() => {
    const runId = projection?.run?.runId;
    if (!runId) return null;
    for (let index = projection.contextCompositions.length - 1; index >= 0; index -= 1) {
      const composition = projection.contextCompositions[index];
      if (composition?.runId === runId) return composition;
    }
    return null;
  }, [projection?.contextCompositions, projection?.run?.runId]);
  const contextCompacting = projection?.run?.status === 'running'
    && latestRunComposition?.purpose === 'contextCompaction';

  const recordProviderStreamProgress = useCallback((identity: string, length: number) => {
    providerStreamProgressRef.current.set(identity, length);
  }, []);

  const finishProviderStream = useCallback((identity: string) => {
    providerStreamProgressRef.current.delete(identity);
    if (transitioningProviderStreamsRef.current.delete(identity)) {
      setProviderStreamCompletionRevision((revision) => revision + 1);
    }
  }, []);

  const committedProviderContent = (
    runId: string,
    providerRequestId: string,
    outputIndex: number | undefined,
    content: string,
    committed: React.ReactNode,
  ): React.ReactNode => {
    if (!projection) throw new Error('conversation_projection_missing_for_committed_content');
    const identity = providerStreamIdentity(
      projection.sessionId,
      runId,
      providerRequestId,
      outputIndex,
    );
    if (!transitioningProviderStreamsRef.current.has(identity)) return committed;
    return (
      <BufferedMarkdown
        key={`committed:${identity}`}
        text={content}
        streamIdentity={identity}
        initialVisibleLength={providerStreamProgressRef.current.get(identity) ?? 0}
        onVisibleLengthChange={recordProviderStreamProgress}
        onCaughtUp={finishProviderStream}
      />
    );
  };

  const recordComposerElementState = (
    element: HTMLTextAreaElement,
    focused: boolean,
  ) => {
    composerStatesRef.current.set(activeComposerStateKeyRef.current, {
      draft: element.value,
      filesystemPaths: pendingFilesystemPaths.map((item) => ({ ...item })),
      pluginSelections: pluginSelections.map((item) => ({ ...item })),
      selectionStart: element.selectionStart ?? element.value.length,
      selectionEnd: element.selectionEnd ?? element.value.length,
      focused,
    });
  };

  const setComposerStateForKey = (key: string, state: ComposerState) => {
    const copy = cloneComposerState(state);
    composerStatesRef.current.set(key, copy);
    if (activeComposerStateKeyRef.current !== key) return;
    setDraft(copy.draft);
    setPendingFilesystemPaths(copy.filesystemPaths);
    setPluginSelections(copy.pluginSelections);
    pendingComposerRestoreRef.current = { key, state: copy };
  };

  const applyLatestFollowMode = useCallback((following: boolean) => {
    followingLatestRef.current = following;
    setFollowingLatest(following);
  }, []);

  const setLatestFollowMode = useCallback((following: boolean) => {
    applyLatestFollowMode(following);
    const activeSessionId = activeViewRef.current;
    if (activeSessionId && pendingViewportRestoreRef.current !== activeSessionId) {
      sessionViewportsRef.current.set(activeSessionId, {
        mode: following ? 'following' : 'detached',
        scrollTop: bodyRef.current?.scrollTop ?? lastScrollTopRef.current,
      });
    }
  }, [applyLatestFollowMode]);

  const scrollToLatestNow = useCallback((behavior: ScrollBehavior = 'auto') => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior });
  }, []);

  const scheduleScrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!followingLatestRef.current || pendingViewportRestoreRef.current !== null) return;
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followingLatestRef.current && pendingViewportRestoreRef.current === null) {
        scrollToLatestNow(behavior);
      }
    });
  }, [scrollToLatestNow]);

  const markTransientUserScroll = useCallback(() => {
    transientUserScrollRef.current = true;
    if (transientUserScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(transientUserScrollFrameRef.current);
    }
    transientUserScrollFrameRef.current = window.requestAnimationFrame(() => {
      transientUserScrollFrameRef.current = window.requestAnimationFrame(() => {
        transientUserScrollRef.current = false;
        transientUserScrollFrameRef.current = null;
      });
    });
  }, []);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    let timeout: number | null = null;

    const schedule = () => {
      if (cancelled || timeout !== null) return;
      const delay = document.visibilityState === 'hidden'
        ? 10_000
        : projectionPollingActive
          ? 750
          : 4_000;
      timeout = window.setTimeout(() => {
        timeout = null;
        void refresh().finally(schedule);
      }, delay);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
      void refresh().finally(schedule);
    };

    schedule();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [projectionPollingActive, refresh, sessionId]);

  useLayoutEffect(() => {
    if (legacyAssistantDraftStreamIdentity) {
      transitioningProviderStreamsRef.current.add(legacyAssistantDraftStreamIdentity);
    }
    if (!projection || !assistantDraft?.orderedBlocks) return;
    for (const block of assistantDraft.orderedBlocks) {
      if (block.kind === 'providerHosted') continue;
      transitioningProviderStreamsRef.current.add(providerStreamIdentity(
        projection.sessionId,
        assistantDraft.runId,
        assistantDraft.turnId,
        block.outputIndex,
      ));
    }
  }, [assistantDraft, legacyAssistantDraftStreamIdentity, projection]);

  useLayoutEffect(() => {
    const previousKey = activeComposerStateKeyRef.current;
    if (previousKey === composerStateKey) return;
    const textarea = textareaRef.current;
    const previous = composerStatesRef.current.get(previousKey);
    const outgoing: ComposerState = {
      draft: textarea?.value ?? draft,
      filesystemPaths: pendingFilesystemPaths.map((item) => ({ ...item })),
      pluginSelections: pluginSelections.map((item) => ({ ...item })),
      selectionStart: textarea?.selectionStart ?? previous?.selectionStart ?? draft.length,
      selectionEnd: textarea?.selectionEnd ?? previous?.selectionEnd ?? draft.length,
      focused: document.activeElement === textarea || previous?.focused === true,
    };
    composerStatesRef.current.set(previousKey, outgoing);

    const cachedIncoming = composerStatesRef.current.get(composerStateKey);
    const incoming = cloneComposerState(
      cachedIncoming ?? { ...emptyComposerState(), focused: outgoing.focused },
    );
    activeComposerStateKeyRef.current = composerStateKey;
    pendingComposerRestoreRef.current = { key: composerStateKey, state: incoming };
    setDraft(incoming.draft);
    setPendingFilesystemPaths(incoming.filesystemPaths);
    setPluginSelections(incoming.pluginSelections);
    setPluginPickerOpen(false);
    setAttachmentMenuOpen(false);
    setAttachmentDialogOpen(false);
    setPermissionMenuOpen(false);
    setAttachmentError(null);
  }, [composerStateKey]);

  useLayoutEffect(() => {
    const pending = pendingComposerRestoreRef.current;
    if (!pending || pending.key !== activeComposerStateKeyRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea || textarea.value !== pending.state.draft) return;
    const selectionStart = Math.min(pending.state.selectionStart, textarea.value.length);
    const selectionEnd = Math.min(
      Math.max(selectionStart, pending.state.selectionEnd),
      textarea.value.length,
    );
    textarea.setSelectionRange(selectionStart, selectionEnd);
    if (pending.state.focused && !textarea.disabled) textarea.focus({ preventScroll: true });
    pendingComposerRestoreRef.current = null;
  });

  useLayoutEffect(() => {
    if (activeViewRef.current !== sessionId) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      pendingViewportRestoreRef.current = sessionId;
      setPluginPickerOpen(false);
      setAttachmentMenuOpen(false);
      setAttachmentDialogOpen(false);
      activeViewRef.current = sessionId;
      const saved = sessionId ? sessionViewportsRef.current.get(sessionId) : undefined;
      applyLatestFollowMode(saved?.mode !== 'detached');
    }
  }, [applyLatestFollowMode, sessionId]);

  useLayoutEffect(() => {
    if (!sessionId || !loading || projection !== null) return;
    if (pendingViewportRestoreRef.current === sessionId) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    pendingViewportRestoreRef.current = sessionId;
  }, [loading, projection, sessionId]);

  useLayoutEffect(() => {
    if (
      !sessionId
      || pendingViewportRestoreRef.current !== sessionId
      || loading
      || projection?.sessionId !== sessionId
    ) return;
    if (viewportRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportRestoreFrameRef.current);
    }
    const targetSessionId = sessionId;
    viewportRestoreFrameRef.current = window.requestAnimationFrame(() => {
      viewportRestoreFrameRef.current = null;
      if (
        activeViewRef.current !== targetSessionId
        || pendingViewportRestoreRef.current !== targetSessionId
      ) return;
      const body = bodyRef.current;
      if (!body) return;
      const saved = sessionViewportsRef.current.get(targetSessionId);
      const following = saved?.mode !== 'detached';
      applyLatestFollowMode(following);
      body.scrollTop = following ? body.scrollHeight : (saved?.scrollTop ?? 0);
      lastScrollTopRef.current = body.scrollTop;
      pendingViewportRestoreRef.current = null;
    });
  }, [
    applyLatestFollowMode,
    loading,
    presentation.layoutKey,
    projection?.sessionId,
    sessionId,
    timelineExtentKey,
  ]);

  useEffect(() => {
    if (followingLatest) scheduleScrollToLatest();
  }, [
    assistantDraftLayoutKey,
    followingLatest,
    scheduleScrollToLatest,
    timelineExtentKey,
  ]);

  useEffect(() => {
    const body = bodyRef.current;
    const transcript = transcriptRef.current;
    if (typeof ResizeObserver === 'undefined' || !body || !transcript) return undefined;
    const observer = new ResizeObserver(() => {
      if (pendingViewportRestoreRef.current !== null) return;
      if (followingLatestRef.current) {
        scheduleScrollToLatest();
        return;
      }
      const activeSessionId = activeViewRef.current;
      const saved = activeSessionId
        ? sessionViewportsRef.current.get(activeSessionId)
        : undefined;
      const userScrolling = transientUserScrollRef.current
        || touchScrollActiveRef.current
        || pointerScrollActiveRef.current;
      if (!activeSessionId || saved?.mode !== 'detached' || userScrolling) return;
      if (detachedViewportFrameRef.current !== null) {
        window.cancelAnimationFrame(detachedViewportFrameRef.current);
      }
      detachedViewportFrameRef.current = window.requestAnimationFrame(() => {
        detachedViewportFrameRef.current = null;
        const currentBody = bodyRef.current;
        const currentSaved = sessionViewportsRef.current.get(activeSessionId);
        if (
          !currentBody
          || activeViewRef.current !== activeSessionId
          || followingLatestRef.current
          || pendingViewportRestoreRef.current !== null
          || currentSaved?.mode !== 'detached'
          || transientUserScrollRef.current
          || touchScrollActiveRef.current
          || pointerScrollActiveRef.current
        ) return;
        currentBody.scrollTop = currentSaved.scrollTop;
        lastScrollTopRef.current = currentBody.scrollTop;
      });
    });
    observer.observe(transcript);
    observer.observe(body);
    return () => {
      observer.disconnect();
      if (detachedViewportFrameRef.current !== null) {
        window.cancelAnimationFrame(detachedViewportFrameRef.current);
        detachedViewportFrameRef.current = null;
      }
    };
  }, [scheduleScrollToLatest, sessionId]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (viewportRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportRestoreFrameRef.current);
    }
    if (detachedViewportFrameRef.current !== null) {
      window.cancelAnimationFrame(detachedViewportFrameRef.current);
    }
    if (transientUserScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(transientUserScrollFrameRef.current);
    }
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!permissionMenuOpen && !attachmentMenuOpen && !pluginPickerOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (permissionMenuOpen && !permissionControlRef.current?.contains(target)) {
        setPermissionMenuOpen(false);
      }
      if (attachmentMenuOpen && !attachmentControlRef.current?.contains(target)) {
        setAttachmentMenuOpen(false);
      }
      if (
        pluginPickerOpen
        && !pluginPickerRef.current?.contains(target)
        && target !== textareaRef.current
      ) {
        setPluginPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [attachmentMenuOpen, permissionMenuOpen, pluginPickerOpen]);

  useEffect(() => {
    const finishPointerScroll = () => {
      if (!pointerScrollActiveRef.current) return;
      pointerScrollActiveRef.current = false;
      markTransientUserScroll();
    };
    window.addEventListener('pointerup', finishPointerScroll);
    window.addEventListener('pointercancel', finishPointerScroll);
    return () => {
      window.removeEventListener('pointerup', finishPointerScroll);
      window.removeEventListener('pointercancel', finishPointerScroll);
    };
  }, [markTransientUserScroll]);

  useEffect(() => {
    if (pendingPlan || pendingInteraction || pendingApproval) {
      setPendingFilesystemPaths([]);
      setPluginSelections([]);
      setPluginPickerOpen(false);
      setAttachmentMenuOpen(false);
      setAttachmentDialogOpen(false);
    }
  }, [pendingApproval, pendingInteraction, pendingPlan]);

  const submitDraft = async () => {
    const submittedText = draft;
    if (
      !submittedText.trim()
      || loading
      || submitting
      || catalogBusy
      || pendingApproval
      || (!selectedProfileId && !pendingInteraction && !pendingPlan)
      || compositionActiveRef.current
      || compositionCommitPendingRef.current
    ) return;
    const submittedComposerKey = activeComposerStateKeyRef.current;
    const submittedFilesystemPaths = pendingFilesystemPaths;
    const submittedPluginSelections = pluginSelections;
    const submittedTextarea = textareaRef.current;
    const submittedComposerState: ComposerState = {
      draft: submittedText,
      filesystemPaths: submittedFilesystemPaths.map((item) => ({ ...item })),
      pluginSelections: submittedPluginSelections.map((item) => ({ ...item })),
      selectionStart: submittedTextarea?.selectionStart ?? submittedText.length,
      selectionEnd: submittedTextarea?.selectionEnd ?? submittedText.length,
      focused: document.activeElement === submittedTextarea,
    };
    setDraft('');
    setPluginPickerOpen(false);
    setLatestFollowMode(true);
    try {
      const focusMatch = submittedText.match(/^\/focus(?:\s+)([\s\S]+)$/u);
      if (focusMatch) {
        await focusContext(
          focusMatch[1]!.trim(),
          submittedFilesystemPaths,
          submittedPluginSelections,
        );
      } else {
        await sendMessage(
          submittedText,
          submittedFilesystemPaths,
          submittedPluginSelections,
        );
      }
      setComposerStateForKey(submittedComposerKey, {
        ...submittedComposerState,
        draft: '',
        filesystemPaths: [],
        pluginSelections: [],
        selectionStart: 0,
        selectionEnd: 0,
      });
      if (activeComposerStateKeyRef.current === submittedComposerKey) {
        setAttachmentError(null);
      }
    } catch {
      setComposerStateForKey(submittedComposerKey, submittedComposerState);
    }
  };

  const beginComposition = () => {
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
      compositionGuardFrameRef.current = null;
    }
    compositionCommitPendingRef.current = false;
    compositionActiveRef.current = true;
  };

  const endComposition = () => {
    compositionActiveRef.current = false;
    compositionCommitPendingRef.current = true;
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
    }
    compositionGuardFrameRef.current = window.requestAnimationFrame(() => {
      compositionGuardFrameRef.current = null;
      compositionCommitPendingRef.current = false;
    });
  };

  const insertFocusCommand = () => {
    const nextDraft = /^\/focus(?:\s|$)/u.test(draft)
      ? draft
      : `/focus ${draft}`;
    focusComposerDraft(nextDraft);
  };

  const selectFocusCommand = () => {
    focusComposerDraft('/focus ');
  };

  const focusComposerDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    setAttachmentMenuOpen(false);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  };

  const filteredPlugins = useMemo(() => {
    const query = pluginQuery.trim().toLocaleLowerCase();
    return pluginCatalog.plugins.filter((plugin) => {
      if (!query) return true;
      return [plugin.displayName, plugin.shortDescription, plugin.uri]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [pluginCatalog.plugins, pluginQuery]);

  useEffect(() => {
    setPluginActiveIndex((current) => Math.min(
      current,
      Math.max(0, filteredPlugins.length - 1),
    ));
  }, [filteredPlugins.length]);

  const openPluginPicker = () => {
    setAttachmentMenuOpen(false);
    setPluginTriggerStart(null);
    setPluginQuery('');
    setPluginActiveIndex(0);
    setPluginPickerOpen(true);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const updateDraft = (value: string, cursor: number) => {
    setDraft(value);
    setPluginSelections((current) => current.filter((selection) => (
      value.includes(`@${selection.label}`)
    )));
    const prefix = value.slice(0, cursor);
    const match = prefix.match(/(^|\s)@([^\s@/]*)$/u);
    if (!match) {
      setPluginPickerOpen(false);
      setPluginTriggerStart(null);
      setPluginQuery('');
      setPluginActiveIndex(0);
      return;
    }
    setPluginTriggerStart(cursor - match[2]!.length - 1);
    setPluginQuery(match[2]!);
    setPluginActiveIndex(0);
    setPluginPickerOpen(true);
  };

  const selectPlugin = (plugin: (typeof pluginCatalog.plugins)[number]) => {
    const cursor = textareaRef.current?.selectionStart ?? draft.length;
    const mention = `@${plugin.displayName}`;
    const alreadySelected = pluginSelections.some((selection) => selection.uri === plugin.uri);
    const insertionStart = pluginTriggerStart ?? (
      draft.length + (draft && !/\s$/u.test(draft) ? 1 : 0)
    );
    const nextDraft = alreadySelected
      ? (pluginTriggerStart === null
          ? draft
          : `${draft.slice(0, pluginTriggerStart)}${draft.slice(cursor)}`)
      : pluginTriggerStart === null
        ? `${draft}${draft && !/\s$/u.test(draft) ? ' ' : ''}${mention} `
        : `${draft.slice(0, pluginTriggerStart)}${mention} ${draft.slice(cursor)}`;
    const nextCursor = alreadySelected
      ? insertionStart
      : insertionStart + mention.length + 1;
    setDraft(nextDraft);
    setPluginSelections((current) => (
      current.some((selection) => selection.uri === plugin.uri)
        ? current
        : [...current, {
            selectionId: nextPanelId('plugin-selection'),
            uri: plugin.uri,
            label: plugin.displayName,
          }]
    ));
    setPluginPickerOpen(false);
    setPluginTriggerStart(null);
    setPluginQuery('');
    setPluginActiveIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const focusCommandSuggestionVisible = shouldOfferFocusCommand(draft);

  const submitOnComposerEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      pluginPickerOpen
      && !event.nativeEvent.isComposing
      && !compositionActiveRef.current
      && !compositionCommitPendingRef.current
    ) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPluginPickerOpen(false);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setPluginActiveIndex((current) => {
          if (filteredPlugins.length === 0) return 0;
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          return (current + delta + filteredPlugins.length) % filteredPlugins.length;
        });
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        const plugin = filteredPlugins[pluginActiveIndex];
        if (plugin) selectPlugin(plugin);
        return;
      }
    }
    if (!shouldSubmitComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    }, {
      active: compositionActiveRef.current,
      commitPending: compositionCommitPendingRef.current,
    })) return;
    event.preventDefault();
    if (focusCommandSuggestionVisible) {
      selectFocusCommand();
      return;
    }
    void submitDraft();
  };

  const submitPlanDecision = useCallback(async (
    response: Extract<PlanResponse, { kind: 'confirm' | 'cancel' }>,
  ) => {
    if (!pendingPlan || submitting) return;
    const submittedComposerKey = activeComposerStateKeyRef.current;
    try {
      await respondPlan(response);
      const cached = composerStatesRef.current.get(submittedComposerKey) ?? emptyComposerState();
      setComposerStateForKey(submittedComposerKey, {
        ...cached,
        draft: '',
        selectionStart: 0,
        selectionEnd: 0,
      });
    } catch {
      // The store preserves the authoritative command error for the shared error panel.
    }
  }, [pendingPlan, respondPlan, submitting]);

  useEffect(() => {
    if (!pendingPlan || submitting) return undefined;
    const ignorePlanOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape'
        || event.repeat
        || compositionActiveRef.current
        || event.isComposing
        || event.keyCode === 229
        || event.defaultPrevented
      ) return;
      event.preventDefault();
      void submitPlanDecision({ kind: 'cancel' });
    };
    window.addEventListener('keydown', ignorePlanOnEscape);
    return () => window.removeEventListener('keydown', ignorePlanOnEscape);
  }, [pendingPlan, submitPlanDecision, submitting]);

  const selectMessageAttachment = async (
    absolutePath: string,
    type: 'directory' | 'file',
  ) => {
    setAttachmentDialogOpen(false);
    if (pendingPlan || pendingInteraction || pendingApproval) return;
    try {
      if (pendingFilesystemPaths.length >= 8) {
        throw new Error(t(language, 'agent.attachment.error.maxFiles'));
      }
      if (type === 'file' && mediaTypeForPath(absolutePath) === 'application/pdf') {
        const matches = pluginCatalog.plugins.filter((plugin) => (
          plugin.activationMediaTypes.includes('application/pdf')
        ));
        if (matches.length !== 1) {
          throw new Error('plugin_selection_unavailable:application/pdf');
        }
        const plugin = matches[0]!;
        setPluginSelections((current) => (
          current.some((selection) => selection.uri === plugin.uri)
            ? current
            : [...current, {
                selectionId: nextPanelId('plugin-selection'),
                uri: plugin.uri,
                label: plugin.displayName,
              }]
        ));
        setDraft((current) => {
          const mention = `@${plugin.displayName}`;
          return current.includes(mention)
            ? current
            : `${current}${current && !/\s$/u.test(current) ? ' ' : ''}${mention} `;
        });
      }
      setPendingFilesystemPaths((current) => (
        current.some((candidate) => (
          candidate.path === absolutePath && candidate.kind === type
        ))
          ? current
          : [...current, { path: absolutePath, kind: type }]
      ));
      setAttachmentError(null);
    } catch (selectionError) {
      setAttachmentError(selectionError instanceof Error
        ? selectionError.message
        : String(selectionError));
    }
  };

  const scrollToLatest = () => {
    setLatestFollowMode(true);
    scheduleScrollToLatest('smooth');
  };

  const copyAssistantMessage = async (messageId: string, content: string) => {
    try {
      await copyTextToClipboard(content);
      setCopiedMessageId(messageId);
      setUiActionError(null);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === messageId ? null : current);
      }, 1_500);
    } catch (copyError) {
      setUiActionError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const updateMessageFeedback = async (
    messageId: string,
    feedback: MessageFeedback | null,
  ) => {
    try {
      await setMessageFeedback(messageId, feedback);
      setUiActionError(null);
    } catch (feedbackError) {
      setUiActionError(feedbackError instanceof Error
        ? feedbackError.message
        : String(feedbackError));
    }
  };

  const canCancel = Boolean(
    projection?.run && ['running', 'waiting'].includes(projection.run.status),
  );
  const canSend = Boolean(draft.trim())
    && !loading
    && !submitting
    && !catalogBusy
    && !pendingApproval
    && Boolean(selectedProfileId || pendingInteraction || pendingPlan);
  const showStopAction = canCancel && !pendingPlan && !draft.trim();

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
          <span className={`local-agent__run-label local-agent__run-label--${projection?.run?.status ?? 'idle'}`}>
            {projection
              ? runLabel(projection.run, language)
              : loading
                ? t(language, 'agent.chat.connecting')
                : t(language, 'agent.chat.new')}
          </span>
        </div>
      </header>

      <div
        ref={bodyRef}
        className="local-agent__body"
        aria-live="polite"
        onWheel={(event) => {
          if (pendingViewportRestoreRef.current === sessionId) return;
          markTransientUserScroll();
          if (event.deltaY < 0) setLatestFollowMode(false);
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) pointerScrollActiveRef.current = true;
        }}
        onKeyDown={(event) => {
          const scrollsAway = ['ArrowUp', 'PageUp', 'Home'].includes(event.key);
          const scrollsTowardLatest = ['ArrowDown', 'PageDown', 'End'].includes(event.key);
          if (!scrollsAway && !scrollsTowardLatest) return;
          markTransientUserScroll();
          if (scrollsAway) setLatestFollowMode(false);
        }}
        onTouchStart={(event) => {
          touchScrollActiveRef.current = true;
          lastTouchYRef.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const currentY = event.touches[0]?.clientY;
          const previousY = lastTouchYRef.current;
          if (currentY !== undefined) {
            if (previousY !== null && currentY > previousY + 2) setLatestFollowMode(false);
            lastTouchYRef.current = currentY;
          }
        }}
        onTouchEnd={() => {
          touchScrollActiveRef.current = false;
          lastTouchYRef.current = null;
          markTransientUserScroll();
        }}
        onTouchCancel={() => {
          touchScrollActiveRef.current = false;
          lastTouchYRef.current = null;
        }}
        onScroll={(event) => {
          const body = event.currentTarget;
          if (
            pendingViewportRestoreRef.current === sessionId
            || (loading && projection === null)
          ) return;
          const scrolledUp = body.scrollTop < lastScrollTopRef.current - 2;
          lastScrollTopRef.current = body.scrollTop;
          const userDriven = transientUserScrollRef.current
            || touchScrollActiveRef.current
            || pointerScrollActiveRef.current;
          if (!userDriven) return;
          const distanceFromLatest = body.scrollHeight - body.scrollTop - body.clientHeight;
          if (scrolledUp && followingLatestRef.current) setLatestFollowMode(false);
          if (!followingLatestRef.current && distanceFromLatest <= 2) {
            setLatestFollowMode(true);
            return;
          }
          if (sessionId) {
            sessionViewportsRef.current.set(sessionId, {
              mode: followingLatestRef.current ? 'following' : 'detached',
              scrollTop: body.scrollTop,
            });
          }
        }}
      >
        <div ref={transcriptRef} className="local-agent__transcript">
          {loading && !projection && (
            <div className="local-agent__empty">{t(language, 'agent.chat.opening')}</div>
          )}
          {!hasConversationContent && !loading && (
            <div className="local-agent__empty local-agent__empty--welcome">
              <strong>
                {activeProject
                  ? t(language, 'agent.chat.welcomeProject', { project: activeProject.title })
                  : t(language, 'agent.chat.welcomeDefault')}
              </strong>
            </div>
          )}
          {conversationItems.map((item) => item.type === 'message' ? (
            <article
              key={`message:${item.value.messageId}`}
              className={`local-agent__message local-agent__message--${item.value.role}`}
            >
              <div className="local-agent__message-content">
                {item.value.role === 'assistant'
                  ? committedProviderContent(
                      item.value.runId,
                      item.value.providerRequestId,
                      item.outputIndex,
                      item.value.content,
                      presentation.content(`message:${item.value.messageId}:content`),
                    )
                  : presentation.content(`message:${item.value.messageId}:content`)}
                {item.value.filesystemReferences.length > 0 && (
                  <div className="local-agent__message-attachments">
                    {item.value.filesystemReferences.map((reference) => (
                      <span
                        className={reference.kind === 'directory'
                          ? 'local-agent__message-directory'
                          : undefined}
                        key={reference.referenceId}
                      >
                        <DeepCodeShellIcon name={reference.kind === 'directory'
                          ? 'folder'
                          : 'artifact'} />
                        {reference.displayName}
                        {reference.kind === 'file' && (
                          <small>{formatBytes(reference.byteLength, language)}</small>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {item.value.role === 'assistant' && (
                <div
                  className="local-agent__message-actions"
                  aria-label={t(language, 'agent.message.actions')}
                >
                  <button
                    type="button"
                    title={t(language, 'agent.message.copy')}
                    aria-label={copiedMessageId === item.value.messageId
                      ? t(language, 'agent.message.copied')
                      : t(language, 'agent.message.copyResponse')}
                    onClick={() => void copyAssistantMessage(item.value.messageId, item.value.content)}
                  >
                    <DeepCodeShellIcon name="copy" />
                  </button>
                  <button
                        type="button"
                        className={item.value.feedback === 'up' ? 'is-selected' : ''}
                        aria-pressed={item.value.feedback === 'up'}
                        title={t(language, 'agent.message.helpful')}
                        aria-label={t(language, 'agent.message.helpful')}
                        disabled={submitting}
                        onClick={() => void updateMessageFeedback(
                          item.value.messageId,
                          item.value.feedback === 'up' ? null : 'up',
                        )}
                      >
                        <DeepCodeShellIcon name="thumbUp" />
                  </button>
                  <button
                        type="button"
                        className={item.value.feedback === 'down' ? 'is-selected' : ''}
                        aria-pressed={item.value.feedback === 'down'}
                        title={t(language, 'agent.message.notHelpful')}
                        aria-label={t(language, 'agent.message.notHelpful')}
                        disabled={submitting}
                        onClick={() => void updateMessageFeedback(
                          item.value.messageId,
                          item.value.feedback === 'down' ? null : 'down',
                        )}
                      >
                        <DeepCodeShellIcon name="thumbDown" />
                  </button>
                </div>
              )}
            </article>
          ) : item.type === 'narrative' ? (
            <article className="local-agent__narrative" key={`narrative:${item.value.narrativeId}`}>
              <div>
                {committedProviderContent(
                  item.value.runId,
                  item.value.providerRequestId,
                  item.outputIndex,
                  item.value.content,
                  presentation.content(`narrative:${item.value.narrativeId}`),
                )}
              </div>
            </article>
          ) : item.type === 'plan' ? (
            <PlanCard
              key={`plan:${item.value.planId}:${item.value.revision}`}
              plan={item.value}
              active={samePlanReference(projection?.activePlanRef, item.value)}
              language={language}
            />
          ) : (
            <ToolActivityGroup
              activities={item.values}
              key={item.groupId}
              language={language}
              onExpand={() => setLatestFollowMode(false)}
              onOpenWorkspaceResource={openWorkspaceResource}
            />
          ))}
          {orderedAssistantDraftItems.map((item) => item.type === 'text' ? (
            <article
              className={item.block.kind === 'narrative'
                ? 'local-agent__narrative local-agent__narrative--draft'
                : 'local-agent__message local-agent__message--assistant local-agent__message--draft'}
              key={`draft:${item.block.outputIndex}`}
            >
              <div className={item.block.kind === 'narrative'
                ? undefined
                : 'local-agent__message-content'}
              >
                <BufferedMarkdown
                  text={item.block.content}
                  streamIdentity={providerStreamIdentity(
                    projection!.sessionId,
                    assistantDraft!.runId,
                    assistantDraft!.turnId,
                    item.block.outputIndex,
                  )}
                  initialVisibleLength={providerStreamProgressRef.current.get(
                    providerStreamIdentity(
                      projection!.sessionId,
                      assistantDraft!.runId,
                      assistantDraft!.turnId,
                      item.block.outputIndex,
                    ),
                  ) ?? 0}
                  onVisibleLengthChange={recordProviderStreamProgress}
                />
              </div>
            </article>
          ) : (
            <ProviderHostedDraftGroup
              blocks={item.blocks}
              key={item.groupId}
              language={language}
              onExpand={() => setLatestFollowMode(false)}
            />
          ))}
          {assistantDraft?.content && legacyAssistantDraftStreamIdentity && (
            <article className="local-agent__message local-agent__message--assistant local-agent__message--draft">
              <div className="local-agent__message-content">
                <BufferedMarkdown
                  key={legacyAssistantDraftStreamIdentity}
                  text={assistantDraft.content}
                  streamIdentity={legacyAssistantDraftStreamIdentity}
                  initialVisibleLength={providerStreamProgressRef.current.get(
                    legacyAssistantDraftStreamIdentity,
                  ) ?? 0}
                  onVisibleLengthChange={recordProviderStreamProgress}
                />
              </div>
            </article>
          )}
          {projection?.run?.status === 'running' && !assistantDraft?.reasoningContent && (
            <div className="local-agent__run-thinking" role="status" aria-live="polite">
              <span className="local-agent__run-spinner" aria-hidden="true" />
              <span>{t(
                language,
                contextCompacting ? 'agent.context.compacting' : 'agent.run.thinking',
              )}</span>
            </div>
          )}
          {projection?.terminalError && (
            <article className="local-agent__terminal-error">
              <strong>{projection.terminalError.code}</strong>
              <span>{projection.terminalError.message}</span>
            </article>
          )}
          <div ref={messageEndRef} />
        </div>
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

      <footer className={`local-agent__composer-shell${pendingPlan || pendingInteraction || pendingApproval
        ? ' local-agent__composer-shell--decision'
        : ''}`}>
        {error && <div className="local-agent__error">{error}</div>}
        {attachmentError && <div className="local-agent__error">{attachmentError}</div>}
        {uiActionError && <div className="local-agent__error">{uiActionError}</div>}
        {presentation.snapshot.status.state === 'unavailable' && (
          <div className="local-agent__error">
            {presentation.snapshot.status.error.message}
          </div>
        )}
        {(pendingPlan || pendingInteraction) && (
          <section className="local-agent__interaction-panel">
            <header className="local-agent__interaction-panel-heading">
              <strong>{pendingPlan
                ? t(language, 'agent.plan.confirmQuestion', { title: pendingPlan.title })
                : pendingInteraction?.prompt}</strong>
              {pendingPlan && (
                <button
                  type="button"
                  className="local-agent__interaction-close"
                  aria-label={t(language, 'agent.plan.ignoreAndStop')}
                  title={t(language, 'agent.plan.ignoreAndStop')}
                  disabled={submitting}
                  onClick={() => void submitPlanDecision({ kind: 'cancel' })}
                >×</button>
              )}
            </header>
            <ol className="local-agent__interaction-options">
              {pendingPlan ? (
                <li>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitPlanDecision({ kind: 'confirm' })}
                  >
                    <span className="local-agent__interaction-option-marker" aria-hidden="true">1</span>
                    <span className="local-agent__interaction-option-copy">
                      <b>{t(language, 'agent.plan.adopt')}</b>
                      <small>{t(language, 'agent.plan.adoptTodoHint')}</small>
                    </span>
                    <span className="local-agent__interaction-option-chevron" aria-hidden="true">
                      <DeepCodeShellIcon name="chevronRight" />
                    </span>
                  </button>
                </li>
              ) : pendingInteraction?.options?.map((option, index) => (
                <li key={option.id}>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      setDraft('');
                      void respondInteraction(option.label).catch(() => undefined);
                    }}
                  >
                    <span className="local-agent__interaction-option-marker" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="local-agent__interaction-option-copy">
                      <b>{option.label}</b>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    <span className="local-agent__interaction-option-chevron" aria-hidden="true">
                      <DeepCodeShellIcon name="chevronRight" />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {(pendingPlan || pendingInteraction?.allowFreeform) && (
              <div className="local-agent__interaction-composer">
                <span className="local-agent__interaction-compose-mark" aria-hidden="true">
                  <DeepCodeShellIcon name="compose" />
                </span>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  rows={1}
                  placeholder={pendingPlan
                    ? t(language, 'agent.composer.placeholder.plan')
                    : t(language, 'agent.composer.placeholder.interaction')}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={(event) => recordComposerElementState(event.currentTarget, true)}
                  onBlur={(event) => recordComposerElementState(event.currentTarget, false)}
                  onSelect={(event) => recordComposerElementState(
                    event.currentTarget,
                    document.activeElement === event.currentTarget,
                  )}
                  onCompositionStart={beginComposition}
                  onCompositionEnd={endComposition}
                  onKeyDown={submitOnComposerEnter}
                />
                {pendingPlan ? (
                  <button
                    type="button"
                    className="local-agent__interaction-secondary"
                    disabled={submitting}
                    onClick={() => void submitPlanDecision({ kind: 'cancel' })}
                  >
                    <span>{t(language, 'agent.plan.ignoreAndStop')}</span>
                    <kbd>Esc</kbd>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="local-agent__interaction-secondary"
                    disabled={submitting}
                    onClick={() => {
                      setDraft('');
                      void respondInteraction(t(language, 'agent.interaction.skip')).catch(() => undefined);
                    }}
                  >{t(language, 'agent.interaction.skip')}</button>
                )}
              </div>
            )}
          </section>
        )}
        {pendingApproval && (
          <section
            className="local-agent__decision"
            aria-labelledby={`approval-${pendingApproval.approvalId}`}
          >
            <header className="local-agent__decision-heading">
              <span className="local-agent__decision-mark" aria-hidden="true">
                <DeepCodeShellIcon name="tool" />
              </span>
              <span className="local-agent__decision-title">
                <strong id={`approval-${pendingApproval.approvalId}`}>
                  {t(language, 'agent.approval.question')}
                </strong>
                <small>{t(language, 'agent.approval.required')}</small>
              </span>
            </header>
            <pre className="local-agent__decision-command">
              <code>{pendingApproval.preview.summary}</code>
            </pre>
            {(pendingApproval.preview.effects.length > 0
              || pendingApproval.preview.logicalTargets.length > 0) && (
              <details className="local-agent__decision-scope">
                <summary>
                  <span>{t(language, 'agent.approval.scope')}</span>
                  <DeepCodeShellIcon name="chevronDown" />
                </summary>
                <dl>
                  {pendingApproval.preview.effects.length > 0 && (
                    <div>
                      <dt>{t(language, 'agent.approval.effects')}</dt>
                      <dd>{pendingApproval.preview.effects.map((effect) => (
                        <code key={effect}>{effect}</code>
                      ))}</dd>
                    </div>
                  )}
                  {pendingApproval.preview.logicalTargets.length > 0 && (
                    <div>
                      <dt>{t(language, 'agent.approval.targets')}</dt>
                      <dd>{pendingApproval.preview.logicalTargets.map((target) => (
                        <code key={target}>{target}</code>
                      ))}</dd>
                    </div>
                  )}
                </dl>
              </details>
            )}
            <div className="local-agent__decision-actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void respondApproval('deny')}
              >{t(language, 'agent.approval.deny')}</button>
              <button
                type="button"
                className="local-agent__button--primary"
                disabled={submitting}
                onClick={() => void respondApproval('allow')}
              >{t(language, 'agent.approval.allow')}</button>
            </div>
          </section>
        )}
        {!pendingPlan && !pendingInteraction && !pendingApproval && <div
          className="local-agent__composer"
          onMouseDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest('button, input, select, textarea, label, a, [role="button"]')) return;
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          {pluginPickerOpen && (
            <div
              ref={pluginPickerRef}
              className="local-agent__plugin-picker"
              role="listbox"
              aria-label={t(language, 'agent.plugin.picker')}
            >
              <div className="local-agent__plugin-picker-heading">
                {t(language, 'agent.plugin.picker')}
              </div>
              {filteredPlugins.length ? filteredPlugins.map((plugin, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === pluginActiveIndex}
                  key={plugin.uri}
                  onClick={() => selectPlugin(plugin)}
                  onMouseEnter={() => setPluginActiveIndex(index)}
                >
                  <DeepCodeShellIcon name="extension" />
                  <span>
                    <b>{plugin.displayName}</b>
                    <small>{plugin.shortDescription}</small>
                  </span>
                  <code>{plugin.uri}</code>
                </button>
              )) : (
                <div className="local-agent__plugin-picker-empty">
                  {t(language, 'agent.plugin.empty')}
                </div>
              )}
            </div>
          )}
          {focusCommandSuggestionVisible && (
            <div
              className="local-agent__command-suggestions"
              role="listbox"
              aria-label={t(language, 'agent.context.focusCommand')}
            >
              <button
                type="button"
                role="option"
                aria-selected="true"
                onClick={selectFocusCommand}
              >
                <DeepCodeShellIcon name="activity" />
                <span>
                  <b>{t(language, 'agent.context.focusCommand')}</b>
                  <small>{t(language, 'agent.context.focusCommandDescription')}</small>
                </span>
                <kbd>/focus</kbd>
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            rows={3}
            placeholder={t(language, 'agent.composer.placeholder.task')}
            onChange={(event) => updateDraft(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            )}
            onFocus={(event) => recordComposerElementState(event.currentTarget, true)}
            onBlur={(event) => recordComposerElementState(event.currentTarget, false)}
            onSelect={(event) => recordComposerElementState(
              event.currentTarget,
              document.activeElement === event.currentTarget,
            )}
            onCompositionStart={beginComposition}
            onCompositionEnd={endComposition}
            onKeyDown={submitOnComposerEnter}
          />
          {(pendingFilesystemPaths.length > 0 || pluginSelections.length > 0) && (
            <div className="local-agent__draft-attachments">
              {pluginSelections.map((selection) => (
                <span className="local-agent__draft-plugin" key={selection.selectionId}>
                  <DeepCodeShellIcon name="extension" />
                  @{selection.label}
                  <button
                    type="button"
                    aria-label={t(language, 'agent.plugin.remove', { name: selection.label })}
                    onClick={() => {
                      setPluginSelections((current) => current.filter((item) => (
                        item.selectionId !== selection.selectionId
                      )));
                      setDraft((current) => current.replace(`@${selection.label}`, '').trimStart());
                    }}
                  >×</button>
                </span>
              ))}
              {pendingFilesystemPaths.map((reference) => (
                <span
                  className={reference.kind === 'directory'
                    ? 'local-agent__draft-directory'
                    : undefined}
                  key={`${reference.kind}:${reference.path}`}
                >
                  <DeepCodeShellIcon name={reference.kind === 'directory'
                    ? 'folder'
                    : 'artifact'} />
                  {reference.kind === 'directory'
                    ? `${t(language, 'agent.attachment.folder')} · `
                    : ''}
                  {filesystemPathDisplayName(reference.path)}
                  <button
                    type="button"
                    aria-label={t(language, 'agent.attachment.remove', {
                      name: filesystemPathDisplayName(reference.path),
                    })}
                    onClick={() => setPendingFilesystemPaths((current) => current.filter((item) => (
                      item.path !== reference.path || item.kind !== reference.kind
                    )))}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <div className="local-agent__composer-footer">
            <div className="local-agent__composer-tools">
              <div ref={attachmentControlRef} className="local-agent__attachment-control">
                <button
                  type="button"
                  className="local-agent__attach"
                  aria-label={t(language, 'agent.attachment.menu')}
                  title={t(language, 'agent.attachment.menu')}
                  aria-expanded={attachmentMenuOpen}
                  aria-haspopup="menu"
                  disabled={catalogBusy}
                  onClick={() => {
                    setAttachmentMenuOpen((open) => !open);
                    setPermissionMenuOpen(false);
                  }}
                >
                  <DeepCodeShellIcon name="plus" />
                </button>
                {attachmentMenuOpen && (
                  <div className="local-agent__attachment-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAttachmentMenuOpen(false);
                        setAttachmentDialogOpen(true);
                      }}
                    >
                      <DeepCodeShellIcon name="paperclip" />
                      <span>
                        <b>{t(language, 'agent.attachment.filesAndFolders')}</b>
                        <small>{t(language, 'agent.attachment.pickerDescription')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={openPluginPicker}
                    >
                      <DeepCodeShellIcon name="extension" />
                      <span>
                        <b>{t(language, 'agent.plugin.menu')}</b>
                        <small>{t(language, 'agent.plugin.menuDescription')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={insertFocusCommand}
                    >
                      <DeepCodeShellIcon name="activity" />
                      <span>
                        <b>{t(language, 'agent.context.focusCommand')}</b>
                        <small>{t(language, 'agent.context.focusCommandDescription')}</small>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <div ref={permissionControlRef} className="local-agent__permission-control">
                <button
                  type="button"
                  className="local-agent__permission-summary"
                  aria-expanded={permissionMenuOpen}
                  onClick={() => {
                    setPermissionMenuOpen((open) => !open);
                    setAttachmentMenuOpen(false);
                  }}
                >
                  {t(
                    language,
                    runtimeEffectiveSettings['agent.permissions.workspaceMutation'] === 'allow'
                      ? 'agent.permission.summary.allow'
                      : 'agent.permission.summary.plan',
                    {
                      external: t(
                        language,
                        runtimeEffectiveSettings['agent.permissions.external'] === 'allow'
                          ? 'agent.permission.allow'
                          : runtimeEffectiveSettings['agent.permissions.external'] === 'deny'
                            ? 'agent.permission.deny'
                            : 'agent.permission.ask',
                      ),
                    },
                  )}
                </button>
                {permissionMenuOpen && (
                  <div className="local-agent__permission-menu">
                    {settingsPendingNextRunActivation && (
                      <div className="local-agent__permission-activation-notice">
                        {t(language, 'agent.permission.nextRunActivationPending')}
                      </div>
                    )}
                    <div className="local-agent__permission-invariant">
                      <span>{t(language, 'agent.permission.workspaceRead')}</span>
                      <strong>{t(language, 'agent.permission.workspaceReadAllowed')}</strong>
                    </div>
                    {permissionSetting(
                      t(language, 'agent.permission.workspaceMutation'),
                      'agent.permissions.workspaceMutation',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        {
                          value: 'plan',
                          label: t(language, 'agent.permission.workspaceMutationPlan'),
                        },
                        {
                          value: 'allow',
                          label: t(language, 'agent.permission.workspaceMutationAllow'),
                        },
                      ],
                      'plan',
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.engineeringDecisions'),
                      'agent.permissions.engineeringDecisions',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        {
                          value: 'ask',
                          label: t(language, 'agent.permission.engineeringDecisionsAsk'),
                        },
                        {
                          value: 'delegate',
                          label: t(language, 'agent.permission.engineeringDecisionsDelegate'),
                        },
                      ],
                      'ask',
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.networkRead'),
                      'agent.permissions.networkRead',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        { value: 'allow', label: t(language, 'agent.permission.allow') },
                        { value: 'ask', label: t(language, 'agent.permission.ask') },
                        { value: 'deny', label: t(language, 'agent.permission.deny') },
                      ],
                      'ask',
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.externalEffects'),
                      'agent.permissions.external',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        { value: 'allow', label: t(language, 'agent.permission.allow') },
                        { value: 'ask', label: t(language, 'agent.permission.ask') },
                        { value: 'deny', label: t(language, 'agent.permission.deny') },
                      ],
                      'ask',
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="local-agent__composer-actions">
              <SessionModelSelector
                language={language}
                profiles={profiles}
                selectedProfileId={selectedProfileId}
                contextUsage={projection?.contextUsage ?? null}
                contextCompositions={projection?.contextCompositions ?? []}
                tokenUsage={projection?.tokenUsage ?? null}
                busy={loading}
                onProfileChange={selectProfile}
              />
              <button
                type="button"
                className={`local-agent__send${showStopAction ? ' local-agent__send--stop' : ''}`}
                aria-label={showStopAction
                  ? t(language, 'agent.composer.stopCurrentRun')
                  : submitting
                    ? t(language, 'agent.composer.sending')
                    : t(language, 'agent.composer.send')}
                title={showStopAction
                  ? t(language, 'agent.composer.stop')
                  : t(language, 'agent.composer.sendEnter')}
                disabled={showStopAction ? submitting : !canSend}
                onClick={() => {
                  if (showStopAction) {
                    void cancelRun();
                    return;
                  }
                  void submitDraft();
                }}
              >
                <DeepCodeShellIcon name={showStopAction ? 'stop' : 'arrowUp'} />
              </button>
            </div>
          </div>
        </div>}
        {!pendingPlan && !pendingInteraction && !pendingApproval && (
          <div className="local-agent__composer-hint">
            {t(language, 'agent.composer.hint')}
          </div>
        )}
      </footer>
      {resourcePreview && (
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
      )}
      {attachmentDialogOpen && (
        <ProjectFolderDialog
          language={language}
          selectionMode="messageAttachment"
          onCancel={() => setAttachmentDialogOpen(false)}
          onSelect={(absolutePath, type) => {
            void selectMessageAttachment(absolutePath, type);
          }}
        />
      )}
    </section>
  );
};

interface ToolActivityGroupProps {
  activities: ActivityProjection[];
  language: UiLanguage;
  onExpand(): void;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

interface ProviderHostedDraftGroupProps {
  blocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>>;
  language: UiLanguage;
  onExpand(): void;
}

const ProviderHostedDraftGroup: React.FC<ProviderHostedDraftGroupProps> = ({
  blocks,
  language,
  onExpand,
}) => {
  const [expanded, setExpanded] = useState(false);
  const failed = blocks.some((block) => block.status === 'failed');
  const firstTarget = blocks.length === 1
    ? providerHostedActionTarget(blocks[0]?.action)
    : '';
  const summary = blocks.length === 1
    ? failed
      ? firstTarget
        ? t(language, 'agent.providerHosted.summary.didNotCompleteTarget', { target: firstTarget })
        : t(language, 'agent.providerHosted.summary.didNotComplete')
      : firstTarget
        ? t(language, 'agent.providerHosted.summary.completedTarget', { target: firstTarget })
        : t(language, 'agent.providerHosted.summary.completed')
    : failed
      ? t(language, 'agent.providerHosted.summary.didNotCompleteMany', { count: blocks.length })
      : t(language, 'agent.providerHosted.summary.completedMany', { count: blocks.length });
  return (
    <article className={`local-agent__tool-group${expanded ? ' local-agent__tool-group--expanded' : ''}${failed ? ' local-agent__tool-group--failed' : ''}`}>
      <button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon name="search" />
        </span>
        <strong>{summary}</strong>
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-group-items">
          {blocks.map((block) => (
            <ProviderHostedEntry
              key={block.providerCallId}
              hosted={block}
              status={block.status}
              language={language}
            />
          ))}
        </div>
      )}
    </article>
  );
};

const ToolActivityGroup: React.FC<ToolActivityGroupProps> = ({
  activities,
  language,
  onExpand,
  onOpenWorkspaceResource,
}) => {
  const terminal = activities.every((activity) => isTerminalActivity(activity.status));
  const [expanded, setExpanded] = useState(() => !terminal);
  const hasFailure = activities.some((activity) => (
    ['failed', 'denied', 'indeterminate'].includes(activity.status)
  ));
  const groupStatus = toolGroupStatus(activities);

  return (
    <article className={`local-agent__tool-group${expanded ? ' local-agent__tool-group--expanded' : ''}${hasFailure ? ' local-agent__tool-group--failed' : ''}`}>
      <button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon
            name={activities.every((activity) => activity.kind === 'providerHosted')
              ? 'search'
              : 'tool'}
          />
        </span>
        <strong>{toolGroupSummary(activities, language)}</strong>
        {groupStatus !== 'completed' && (
          <span>{toolActivityStatus(groupStatus, language)}</span>
        )}
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-group-items">
          {activities.map((activity) => (
            <ToolActivityEntry
              activity={activity}
              key={activity.activityId}
              language={language}
              onOpenWorkspaceResource={onOpenWorkspaceResource}
            />
          ))}
        </div>
      )}
    </article>
  );
};

interface ProviderHostedEntryProps {
  hosted: ProviderHostedActivityProjection;
  status: ActivityProjection['status'];
  language: UiLanguage;
}

const ProviderHostedEntry: React.FC<ProviderHostedEntryProps> = ({ hosted, status, language }) => {
  const actionType = providerHostedActionType(hosted.action);
  const fieldLabels: Record<string, string> = {
    queries: 'agent.providerHosted.detail.queries',
    query: 'agent.providerHosted.detail.queries',
    url: 'agent.providerHosted.detail.url',
    pattern: 'agent.providerHosted.detail.pattern',
    sources: 'agent.providerHosted.detail.sources',
  };
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${status}`}>
      <div className="local-agent__tool-entry-details">
        <dl>
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.status')}</dt>
            <dd>{toolActivityStatus(status, language)}</dd>
          </div>
          {actionType && (
            <div>
              <dt>{t(language, 'agent.providerHosted.detail.action')}</dt>
              <dd><code>{actionType}</code></dd>
            </div>
          )}
          {Object.entries(hosted.action).filter(([field]) => field !== 'type').map(([field, value]) => (
            <div key={field}>
              <dt>{fieldLabels[field] ? t(language, fieldLabels[field]) : field}</dt>
              <dd><code>{typeof value === 'string'
                ? value
                : Array.isArray(value) && value.every((item) => typeof item === 'string')
                  ? value.join('\n')
                  : JSON.stringify(value, null, 2)}</code></dd>
            </div>
          ))}
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.providerTool')}</dt>
            <dd><code>{hosted.providerToolType}</code></dd>
          </div>
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.providerCallId')}</dt>
            <dd><code>{hosted.providerCallId}</code></dd>
          </div>
        </dl>
      </div>
    </div>
  );
};

interface ToolActivityEntryProps {
  activity: ActivityProjection;
  language: UiLanguage;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

const ToolActivityEntry: React.FC<ToolActivityEntryProps> = ({
  activity,
  language,
  onOpenWorkspaceResource,
}) => {
  const [expanded, setExpanded] = useState(false);
  const tool = activity.tool;
  const shell = tool?.shell;
  const result = shell?.result;
  if (activity.providerHosted) {
    return (
      <ProviderHostedEntry
        hosted={activity.providerHosted}
        status={activity.status}
        language={language}
      />
    );
  }
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${activity.status}`}>
      <button
        type="button"
        className="local-agent__tool-entry-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <strong>{toolActivitySummary(activity, language)}</strong>
        {activity.status !== 'completed' && (
          <span>{toolActivityStatus(activity.status, language)}</span>
        )}
        <span className="local-agent__tool-entry-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-entry-details">
          <dl>
            <div>
              <dt>{t(language, 'agent.tool.detail.operation')}</dt>
              <dd><code>{tool?.operation ?? activity.label}</code></dd>
            </div>
            {shell && (
              <>
                <div>
                  <dt>{t(language, 'agent.tool.shell.command')}</dt>
                  <dd><code>{shell.command}</code></dd>
                </div>
                <div>
                  <dt>{t(language, 'agent.tool.shell.cwd')}</dt>
                  <dd><code>{shell.cwd}</code></dd>
                </div>
                {result && (
                  <>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.environment')}</dt>
                      <dd>{t(language, 'agent.tool.shell.environmentValue', {
                        shell: result.environment.shell,
                      })}</dd>
                    </div>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.writeScope')}</dt>
                      <dd>{t(
                        language,
                        `agent.tool.shell.writeScope.${result.environment.writeScope}`,
                      )}</dd>
                    </div>
                  </>
                )}
              </>
            )}
          </dl>
          {tool?.resources.length ? (
            <div className="local-agent__tool-resources">
              {tool.resources.map((resource, index) => {
                const key = `${resource.kind}:${resource.workspaceId ?? ''}:${resource.logicalPath ?? resource.uri ?? resource.label}:${index}`;
                if (
                  resource.kind === 'workspacePath'
                  && resource.workspaceId
                  && resource.logicalPath
                ) {
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => onOpenWorkspaceResource(
                        resource.workspaceId!, resource.logicalPath!,
                      )}
                    >
                      {resource.label}
                    </button>
                  );
                }
                if (resource.kind === 'url' && resource.uri) {
                  return (
                    <a href={resource.uri} key={key} rel="noreferrer" target="_blank">
                      {resource.label}
                    </a>
                  );
                }
                return <span key={key}>{resource.label}</span>;
              })}
            </div>
          ) : null}
          {result && (
            <div className="local-agent__shell-result">
              <div className="local-agent__shell-result-meta">
                <span>{t(language, 'agent.tool.shell.exit', {
                  code: result.exitCode ?? t(language, 'agent.tool.shell.noExitCode'),
                })}</span>
                <span>{t(language, 'agent.tool.shell.duration', {
                  duration: result.durationMs,
                })}</span>
                {result.timedOut && <span>{t(language, 'agent.tool.shell.timedOut')}</span>}
                {result.truncated && <span>{t(language, 'agent.tool.shell.truncated')}</span>}
              </div>
              {result.stdout && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stdout')}</span>
                  <pre>{result.stdout}</pre>
                </section>
              )}
              {result.stderr && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stderr')}</span>
                  <pre>{result.stderr}</pre>
                </section>
              )}
              {!result.stdout && !result.stderr && (
                <small>{t(language, 'agent.tool.shell.noOutput')}</small>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function permissionSetting(
  label: string,
  key: string,
  settings: Record<string, unknown>,
  patch: (key: string, value: string) => Promise<unknown>,
  options: readonly {value: string; label: string}[],
  defaultValue: string,
): React.ReactNode {
  return (
    <label>
      <span>{label}</span>
      <select
        value={String(settings[key] ?? defaultValue)}
        onChange={(event) => void patch(key, event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function runLabel(run: RunProjection | null, language: UiLanguage): string {
  if (!run) return t(language, 'agent.run.status.idle');
  if (run.status === 'waiting' && run.waitingReason === 'userInput') {
    return t(language, 'agent.run.status.waitingUserInput');
  }
  if (run.status === 'waiting' && run.waitingReason === 'plan') {
    return t(language, 'agent.run.status.waitingPlan');
  }
  return t(language, `agent.run.status.${run.status}`);
}

function samePlanReference(
  reference: { planId: string; revision: number } | null | undefined,
  plan: { planId: string; revision: number },
): boolean {
  return reference?.planId === plan.planId && reference.revision === plan.revision;
}

type ProjectionItem =
  | {
      type: 'message';
      sequence: number;
      outputIndex?: number;
      value: SessionProjection['messages'][number];
    }
  | {
      type: 'narrative';
      sequence: number;
      outputIndex?: number;
      value: SessionProjection['narratives'][number];
    }
  | { type: 'plan'; sequence: number; value: SessionProjection['plans'][number] }
  | {
      type: 'toolGroup';
      sequence: number;
      groupId: string;
      values: ActivityProjection[];
    };

type AssistantDraftItem =
  | {
      type: 'text';
      block: Exclude<AssistantDraftBlockProjection, { kind: 'providerHosted' }>;
    }
  | {
      type: 'providerHostedGroup';
      groupId: string;
      blocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>>;
    };

function assistantDraftItems(
  draft: SessionProjection['assistantDraft'],
): AssistantDraftItem[] {
  if (!draft?.orderedBlocks) return [];
  const items: AssistantDraftItem[] = [];
  let hostedBlocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>> = [];
  const flushHostedBlocks = (): void => {
    if (hostedBlocks.length === 0) return;
    items.push({
      type: 'providerHostedGroup',
      groupId: `draft-hosted:${draft.turnId}:${hostedBlocks[0]!.outputIndex}`,
      blocks: hostedBlocks,
    });
    hostedBlocks = [];
  };
  for (const block of draft.orderedBlocks) {
    if (block.kind !== 'providerHosted') {
      flushHostedBlocks();
      items.push({ type: 'text', block });
      continue;
    }
    hostedBlocks.push(block);
  }
  flushHostedBlocks();
  return items;
}

function projectionItems(projection: SessionProjection | null): ProjectionItem[] {
  if (!projection) return [];
  return projection.timeline.map((item): ProjectionItem => {
    switch (item.kind) {
      case 'message':
        return {
          type: 'message',
          sequence: item.sequence,
          ...(item.outputIndex !== undefined ? { outputIndex: item.outputIndex } : {}),
          value: requiredProjectionValue(
            projection.messages,
            (message) => message.messageId === item.messageId,
            'conversation_timeline_message_missing',
          ),
        };
      case 'narrative':
        return {
          type: 'narrative',
          sequence: item.sequence,
          ...(item.outputIndex !== undefined ? { outputIndex: item.outputIndex } : {}),
          value: requiredProjectionValue(
            projection.narratives,
            (narrative) => narrative.narrativeId === item.narrativeId,
            'conversation_timeline_narrative_missing',
          ),
        };
      case 'plan':
        return {
          type: 'plan',
          sequence: item.sequence,
          value: requiredProjectionValue(
            projection.plans,
            (plan) => plan.planId === item.planId && plan.revision === item.revision,
            'conversation_timeline_plan_missing',
          ),
        };
      case 'toolGroup':
        return {
          type: 'toolGroup',
          sequence: item.sequence,
          groupId: item.timelineId,
          values: item.activityIds.map((activityId) => requiredProjectionValue(
            projection.activities,
            (activity) => activity.activityId === activityId,
            'conversation_timeline_activity_missing',
          )),
        };
    }
  });
}

function requiredProjectionValue<Value>(
  values: readonly Value[],
  predicate: (value: Value) => boolean,
  error: string,
): Value {
  const value = values.find(predicate);
  if (!value) throw new Error(error);
  return value;
}

function toolGroupSummary(
  activities: ActivityProjection[],
  language: UiLanguage,
): string {
  const status = toolGroupStatus(activities);
  if (activities.every((activity) => activity.kind === 'providerHosted')) {
    if (activities.length === 1) return toolActivitySummary(activities[0], language);
    if (status === 'completed') {
      return t(language, 'agent.providerHosted.summary.completedMany', {
        count: activities.length,
      });
    }
    if (['failed', 'cancelled', 'indeterminate', 'denied'].includes(status)) {
      return t(language, 'agent.providerHosted.summary.didNotCompleteMany', {
        count: activities.length,
      });
    }
    return t(language, 'agent.providerHosted.summary.activeMany', {
      count: activities.length,
    });
  }
  const operation = activities.length === 1
    ? (activities[0].tool?.operation ?? activities[0].label)
    : null;
  if (status === 'active') {
    if (operation) return t(language, 'agent.tool.summary.activeOne', { operation });
    return t(language, 'agent.tool.summary.activeMany', { count: activities.length });
  }
  if (status === 'requested') {
    if (operation) return t(language, 'agent.tool.summary.requestedOne', { operation });
    return t(language, 'agent.tool.summary.requestedMany', { count: activities.length });
  }
  if (status === 'waiting') {
    if (operation) return t(language, 'agent.tool.summary.waitingOne', { operation });
    return t(language, 'agent.tool.summary.waitingMany', { count: activities.length });
  }
  if (activities.length === 1) {
    return toolActivitySummary(activities[0], language);
  }
  if (status === 'completed') {
    const hasShell = activities.some((activity) => (
      activity.tool?.operation === 'bash'
    ));
    const editCount = activities.filter((activity) => (
      isFileMutationOperation(activity.tool?.operation)
    )).length;
    if (hasShell && editCount > 0) {
      return t(language, 'agent.tool.summary.editedAndRan');
    }
    if (editCount === activities.length) {
      return t(language, 'agent.tool.summary.editedMany', { count: editCount });
    }
  }
  return t(language, 'agent.tool.summary.usedMany', { count: activities.length });
}

function toolActivitySummary(activity: ActivityProjection, language: UiLanguage): string {
  if (activity.kind === 'providerHosted' && activity.providerHosted) {
    const target = providerHostedActionTarget(activity.providerHosted.action);
    const failed = ['failed', 'denied', 'indeterminate', 'cancelled'].includes(activity.status);
    if (activity.status === 'completed') {
      return target
        ? t(language, 'agent.providerHosted.summary.completedTarget', { target })
        : t(language, 'agent.providerHosted.summary.completed');
    }
    if (failed) {
      return target
        ? t(language, 'agent.providerHosted.summary.didNotCompleteTarget', { target })
        : t(language, 'agent.providerHosted.summary.didNotComplete');
    }
    return target
      ? t(language, 'agent.providerHosted.summary.activeTarget', { target })
      : t(language, 'agent.providerHosted.summary.active');
  }
  const operation = activity.tool?.operation ?? activity.label;
  const target = activity.tool?.resources[0]?.label;
  const command = activity.tool?.shell?.command;
  if (activity.status === 'completed') {
    if (operation === 'bash' && command) {
      return t(language, 'agent.tool.activity.ranCommand', { command });
    }
    if (operation === 'fs.delete' && target) {
      return t(language, 'agent.tool.activity.deletedPath', { path: target });
    }
    if (isFileMutationOperation(operation) && target) {
      return t(language, 'agent.tool.activity.editedPath', { path: target });
    }
    if (operation === 'fs.read' && target) {
      return t(language, 'agent.tool.activity.readPath', { path: target });
    }
    return t(language, 'agent.tool.summary.usedOne', { operation });
  }
  if (['failed', 'denied', 'indeterminate', 'cancelled'].includes(activity.status)) {
    if (operation === 'bash' && command) {
      return t(language, 'agent.tool.activity.commandDidNotComplete', { command });
    }
    return t(language, 'agent.tool.activity.didNotComplete', {
      operation,
      target: target ? ` · ${target}` : '',
    });
  }
  if (operation === 'bash' && command) {
    return t(language, 'agent.tool.activity.runningCommand', { command });
  }
  return t(language, 'agent.tool.activity.runningOperation', {
    operation,
    target: target ? ` · ${target}` : '',
  });
}

function providerHostedActionType(action: Record<string, unknown> | undefined): string {
  return typeof action?.type === 'string' ? action.type : '';
}

function providerHostedActionTarget(action: Record<string, unknown> | undefined): string {
  if (!action) return '';
  if (Array.isArray(action.queries)) {
    const queries = action.queries.filter((query): query is string => (
      typeof query === 'string' && query.length > 0
    ));
    if (queries.length > 0) return queries.join(' · ');
  }
  for (const field of ['query', 'url', 'pattern']) {
    const value = action[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function isFileMutationOperation(operation: string | undefined): boolean {
  return operation !== undefined && [
    'fs.write',
    'fs.edit',
    'fs.delete',
  ].includes(operation);
}

function isTerminalActivity(status: ActivityProjection['status']): boolean {
  return ['completed', 'denied', 'failed', 'cancelled', 'indeterminate'].includes(status);
}

function toolActivityStatus(
  status: ActivityProjection['status'],
  language: UiLanguage,
): string {
  return t(language, `agent.tool.status.${status}`);
}

function toolGroupStatus(
  activities: ActivityProjection[],
): ActivityProjection['status'] {
  const priority: ActivityProjection['status'][] = [
    'active',
    'waiting',
    'requested',
    'failed',
    'denied',
    'indeterminate',
    'cancelled',
    'completed',
  ];
  return priority.find((status) => activities.some((activity) => activity.status === status))
    ?? 'indeterminate';
}

function emptyComposerState(): ComposerState {
  return {
    draft: '',
    filesystemPaths: [],
    pluginSelections: [],
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
  };
}

function cloneComposerState(state: ComposerState): ComposerState {
  return {
    ...state,
    filesystemPaths: state.filesystemPaths.map((item) => ({ ...item })),
    pluginSelections: state.pluginSelections.map((item) => ({ ...item })),
  };
}

function providerStreamIdentity(
  sessionId: string,
  runId: string,
  providerRequestId: string,
  outputIndex?: number,
): string {
  return outputIndex === undefined
    ? `${sessionId}\u0000${runId}\u0000${providerRequestId}`
    : `${sessionId}\u0000${runId}\u0000${providerRequestId}\u0000${outputIndex}`;
}

function nextPanelId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${random}`;
}

function filesystemPathDisplayName(absolutePath: string): string {
  const normalized = absolutePath.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).at(-1) || absolutePath;
}

function mediaTypeForPath(absolutePath: string): string {
  return absolutePath.toLocaleLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : 'application/octet-stream';
}

function formatBytes(value: number, language: UiLanguage): string {
  if (value < 1024) {
    return t(language, 'agent.attachment.size.bytes', {
      value: value.toLocaleString(language),
    });
  }
  return t(language, 'agent.attachment.size.kibibytes', {
    value: Math.ceil(value / 1024).toLocaleString(language),
  });
}

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

export default LocalAgentPanel;
