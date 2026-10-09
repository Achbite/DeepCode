import type { InteractionProjection } from '@deepcode/protocol';
import { useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { MarkdownContent } from './BufferedMarkdown';
import { useConversationRowState } from './ConversationVirtualRow';

/** Answers identify the journal question, even while another Provider turn runs. */
export function InteractionCard({ interaction, language }: { interaction: InteractionProjection; language: UiLanguage }) {
  const respond = useLocalAgentStore(state => state.respondInteraction);
  const [text, setText] = useConversationRowState(`question:${interaction.interactionId}:draft`, '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = interaction.status === 'pending';
  const answer = async (response: string) => {
    if (!pending || sending || !response.trim()) return;
    setSending(true); setError(null);
    try { await respond(response, interaction.interactionId); setText(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  };
  return <article className="local-agent__question" aria-label={t(language, 'agent.question.title')}>
    <header>{t(language, `agent.question.${interaction.status}`)}</header>
    <MarkdownContent decisionProse>{interaction.prompt}</MarkdownContent>
    {pending && <div className="local-agent__question-options">
      {interaction.options?.map(option => <button key={option.id} type="button" disabled={sending}
        onClick={() => { void answer(option.id); }}>
        <strong>{option.label}</strong>{option.description && <span>{option.description}</span>}
      </button>)}
      {interaction.allowFreeform && <form onSubmit={event => { event.preventDefault(); void answer(text); }}>
        <textarea aria-label={t(language, 'agent.question.answer')} value={text} disabled={sending}
          onChange={event => setText(event.target.value)} rows={2} />
        <button type="submit" disabled={sending || !text.trim()}>{t(language, 'agent.question.answer')}</button>
      </form>}
    </div>}
    {interaction.status === 'answered' && <p>{interaction.options?.find(option => option.id === interaction.response)?.label ?? interaction.response}</p>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
