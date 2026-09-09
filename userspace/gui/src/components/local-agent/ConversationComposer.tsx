import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import type { PresentedCommittedContent } from '../../presentation/PresentationRuntime';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import SessionModelSelector from './SessionModelSelector';
import { ComposerDecisionPanels } from './ComposerDecisionPanels';
import { ComposerPermissionControl } from './ComposerPermissionControl';
import type { AgentComposer } from './useAgentComposer';

interface ConversationComposerProps {
  changeBar?: React.ReactNode;
  language: UiLanguage;
  composer: AgentComposer;
  uiActionError: string | null;
  presentationStatus: PresentedCommittedContent['snapshot']['status'];
}

export function ConversationComposer({
  changeBar,
  language,
  composer,
  uiActionError,
  presentationStatus,
}: ConversationComposerProps) {
  const {
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
    setAttachmentDialogOpen,
    setPermissionMenuOpen,
    attachmentControlRef,
    pluginPickerRef,
    textareaRef,
    recordComposerElementState,
    beginComposition,
    endComposition,
    submitOnComposerEnter,
    filteredPlugins,
    selectPlugin,
    focusCommandSuggestionVisible,
    selectFocusCommand,
    updateDraft,
    openPluginPicker,
    insertFocusCommand,
    submitDraft,
    canSend,
    showStopAction,
  } = composer;
  return (
    <footer className={`local-agent__composer-shell${pendingPlan || pendingInteraction || pendingApproval
      ? ' local-agent__composer-shell--decision'
      : ''}`}>
      {error && <div className="local-agent__error">{error}</div>}
      {attachmentError && <div className="local-agent__error">{attachmentError}</div>}
      {uiActionError && <div className="local-agent__error">{uiActionError}</div>}
      {presentationStatus.state === 'unavailable' && (
        <div className="local-agent__error">
          {presentationStatus.error.message}
        </div>
      )}
      <div className="conversation-change-dock" aria-live="polite">{changeBar}</div>
      <ComposerDecisionPanels language={language} composer={composer} />
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
            <ComposerPermissionControl language={language} composer={composer} />
          </div>
          <div className="local-agent__composer-actions">
            <SessionModelSelector
              language={language}
              profiles={profiles}
              selectedProfileId={selectedProfileId}
              reasoningEffortOverride={reasoningEffortOverride}
              contextUsage={projection?.contextUsage ?? null}
              contextCompositions={projection?.contextCompositions ?? []}
              busy={loading || submitting || modelSettingsBusy}
              onProfileChange={selectProfile}
              onReasoningEffortChange={selectReasoningEffort}
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
  );
}

function filesystemPathDisplayName(absolutePath: string): string {
  const normalized = absolutePath.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).at(-1) || absolutePath;
}
