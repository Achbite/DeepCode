import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import SessionModelSelector from './SessionModelSelector';
import { ComposerDecisionPanels } from './ComposerDecisionPanels';
import { ComposerPermissionControl } from './ComposerPermissionControl';
import type { AgentComposer } from './useAgentComposer';
import { pastedTextTitle } from '../../services/pastedText';

interface ConversationComposerProps {
  changeBar?: React.ReactNode;
  language: UiLanguage;
  composer: AgentComposer;
  uiActionError: string | null;
}

export function ConversationComposer({
  changeBar,
  language,
  composer,
  uiActionError,
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
      {composer.failedDrafts.map((failed, index) => <details className="local-agent__failed-draft" key={index}>
        <summary>{language === 'zh-CN' ? '未发送草稿已保留' : 'Unsent draft saved'}</summary>
        <pre>{[failed.draft, ...failed.pastedTexts.map((item) => item.text)].filter(Boolean).join('\n\n')}</pre>
        {failed.filesystemPaths.map((item) => <div key={item.path}>{item.path}</div>)}
        {failed.pluginSelections.map((item) => <div key={item.selectionId}>@{item.label}</div>)}
        <button type="button" disabled={!composer.canRestoreFailedDraft} onClick={() => composer.restoreFailedDraft(index)}>
          {language === 'zh-CN' ? '恢复到输入框' : 'Restore draft'}
        </button>
        {!composer.canRestoreFailedDraft && <small>{language === 'zh-CN' ? '发送或清空当前草稿后可恢复。' : 'Send or clear the current draft to restore this one.'}</small>}
      </details>)}
      <div className="conversation-change-dock" aria-live="polite">{changeBar}</div>
      <ComposerDecisionPanels language={language} composer={composer} />
      {projection?.queuedInputs.map((input) => <div className="local-agent__queued-input" key={input.commandId} role="status">
        <strong>{input.status === 'queued'
          ? (language === 'zh-CN' ? '等待加入当前任务' : 'Waiting to join this run')
          : (language === 'zh-CN' ? '未加入本轮' : 'Not applied to this run')}</strong>
        <span>{input.text}{input.filesystemReferences.length ? ` · ${input.filesystemReferences.map((item) => item.displayName).join(', ')}` : ''}</span>
      </div>)}
      <div
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
                disabled={!plugin.enabled || !plugin.available}
                onClick={() => selectPlugin(plugin)}
                onMouseEnter={() => setPluginActiveIndex(index)}
              >
                <DeepCodeShellIcon name="extension" />
                <span>
                  <b>{plugin.displayName}</b>
                  <small>{plugin.shortDescription}</small>
                  {(!plugin.enabled || !plugin.available) && <small>{plugin.error
                    ? `${plugin.error.code}: ${plugin.error.message}`
                    : language === 'zh-CN' ? '插件未启用' : 'Plugin disabled'}</small>}
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
        {selectedProfileId && !profiles.some((profile) => profile.id === selectedProfileId && profile.enabled) && (
          <p className="local-agent__profile-notice" role="status">{t(language, 'agent.profile.boundUnavailable')}</p>
        )}
        {composer.pastedTexts.map((paste, index) => (
          <div className="local-agent__pasted-text" key={index}>
            <div className="local-agent__pasted-text-header">
              <DeepCodeShellIcon name="artifact" />
              <span><strong>{pastedTextTitle(paste.text)}</strong><small>TXT · {(new TextEncoder().encode(paste.text).byteLength / 1024).toFixed(1)} KiB</small></span>
              <button type="button" aria-label="移除粘贴文本" onClick={() => composer.setPastedTexts((current) => current.filter((item) => item.inputId !== paste.inputId))}>×</button>
            </div>
            <button type="button" className="local-agent__paste-toggle" aria-expanded={paste.expanded} onClick={() => composer.setPastedTexts((current) => current.map((item) => item.inputId === paste.inputId ? { ...item, expanded: !item.expanded } : item))}>
              {paste.expanded ? '收起原文' : '在文本框中显示'}
            </button>
            {paste.expanded && <textarea aria-label="粘贴文本原文" value={paste.text} onChange={(event) => composer.editPastedText(paste.inputId, event.target.value)} rows={8} />}
          </div>
        ))}
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
          onPaste={composer.pasteText}
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
            {showStopAction && <button
              type="button"
              className="local-agent__send local-agent__send--stop"
              aria-label={t(language, 'agent.composer.stopCurrentRun')}
              title={t(language, 'agent.composer.stop')}
              onClick={() => void cancelRun()}
            ><DeepCodeShellIcon name="stop" /></button>}
            <button
              type="button"
              className="local-agent__send"
              aria-label={submitting
                  ? t(language, 'agent.composer.sending')
                  : t(language, 'agent.composer.send')}
              title={t(language, 'agent.composer.sendEnter')}
              disabled={!canSend}
              onClick={() => void submitDraft()}
            >
              <DeepCodeShellIcon name="arrowUp" />
            </button>
          </div>
        </div>
      </div>
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
