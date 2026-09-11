import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlanResponse, PluginSelectionInput } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { shouldOfferFocusCommand, shouldSubmitComposerKey } from './composerKeyboard';

interface PendingFilesystemPath {
  path: string;
  kind: 'file' | 'directory';
}

interface ComposerState {
  draft: string;
  filesystemPaths: PendingFilesystemPath[];
  pluginSelections: PluginSelectionInput[];
  selectionStart: number;
  selectionEnd: number;
  focused: boolean;
}

export function useAgentComposer(
  language: UiLanguage,
  setLatestFollowMode: (following: boolean) => void,
) {
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
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
  const loading = useLocalAgentStore((state) => state.loading);
  const submitting = useLocalAgentStore((state) => state.submitting);
  const catalogBusy = useLocalAgentStore((state) => state.catalogBusy);
  const error = useLocalAgentStore((state) => state.error);
  const sendMessage = useLocalAgentStore((state) => state.sendMessage);
  const focusContext = useLocalAgentStore((state) => state.focusContext);
  const respondInteraction = useLocalAgentStore((state) => state.respondInteraction);
  const respondApproval = useLocalAgentStore((state) => state.respondApproval);
  const respondPlan = useLocalAgentStore((state) => state.respondPlan);
  const cancelRun = useLocalAgentStore((state) => state.cancelRun);
  const selectProfile = useLocalAgentStore((state) => state.selectProfile);
  const selectReasoningEffort = useLocalAgentStore((state) => state.selectReasoningEffort);
  const reasoningEffortOverride = useLocalAgentStore((state) => state.reasoningEffortOverride);
  const modelSettingsBusy = useLocalAgentStore((state) => state.modelSettingsBusy);
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

  useEffect(() => () => {
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

  const canCancel = Boolean(
    projection?.run && ['running', 'waiting'].includes(projection.run.status),
  );
  const canSend = Boolean(draft.trim())
    && !modelSettingsBusy
    && !loading
    && !submitting
    && !catalogBusy
    && !pendingApproval
    && Boolean(profiles.some((profile) => profile.id === selectedProfileId && profile.enabled) || pendingInteraction || pendingPlan);
  const showStopAction = canCancel && !pendingPlan && !draft.trim();

  return {
    pendingPlan,
    pendingInteraction,
    pendingApproval,
    projection,
    loading,
    submitting,
    catalogBusy,
    error,
    profiles,
    selectedProfileId,
    reasoningEffortOverride,
    modelSettingsBusy,
    respondInteraction,
    respondApproval,
    cancelRun,
    selectProfile,
    selectReasoningEffort,
    draft,
    setDraft,
    pendingFilesystemPaths,
    setPendingFilesystemPaths,
    pluginSelections,
    setPluginSelections,
    pluginPickerOpen,
    pluginActiveIndex,
    setPluginActiveIndex,
    attachmentError,
    attachmentMenuOpen,
    setAttachmentMenuOpen,
    attachmentDialogOpen,
    setAttachmentDialogOpen,
    permissionMenuOpen,
    setPermissionMenuOpen,
    attachmentControlRef,
    pluginPickerRef,
    permissionControlRef,
    textareaRef,
    recordComposerElementState,
    beginComposition,
    endComposition,
    submitOnComposerEnter,
    submitPlanDecision,
    filteredPlugins,
    selectPlugin,
    focusCommandSuggestionVisible,
    selectFocusCommand,
    updateDraft,
    openPluginPicker,
    insertFocusCommand,
    submitDraft,
    selectMessageAttachment,
    canSend,
    showStopAction,
  };
}

export type AgentComposer = ReturnType<typeof useAgentComposer>;

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

function nextPanelId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${random}`;
}

function mediaTypeForPath(absolutePath: string): string {
  return absolutePath.toLocaleLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : 'application/octet-stream';
}
