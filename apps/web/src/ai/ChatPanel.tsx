import { useEffect, useState } from 'react';
import { api, ApiError, type AiPersonaDto, type AiSettingsDto, type ChatMessageDto, type ToolCallOutcomeDto } from '../app/api';
import { Icon } from '../ui/Icon';
import { groupPersonasByCategory } from './persona-grouping';
import { AI_CHAT_DISABLED_MESSAGE, AI_MOCK_MODE_MESSAGE } from './ai-status-messages';

export interface ChatPanelProps {
  diagramId: string;
  currentDslContent: string;
  onDiagramUpdated: (updatedDslContent: string) => void;
}

interface LocalMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The tool wrappers themselves supply a human-readable `reason` for anything that couldn't be
 * applied (diagram-tools.ts) — surface those directly rather than depending on the model's own
 * generated text to mention it (FR-014). Used for both a live response and loaded history, so
 * past "not found" notices still render the same way after a reload. */
function formatAssistantContent(text: string, toolCalls: ToolCallOutcomeDto[] | null): string {
  const notes = (toolCalls ?? []).filter((tc) => !tc.applied && tc.reason).map((tc) => tc.reason as string);
  return [text, ...notes].filter(Boolean).join(' ');
}

/** Persistent per-diagram chat panel (User Story 2, FR-011; history load-on-open is User Story
 * 4, FR-015): edits apply as targeted, minimal `diagram-core` operations against the editor's
 * current live DSL — the same mutation path a manual canvas edit takes — so chat and manual
 * edits interleave freely without either undoing the other. */
export function ChatPanel({ diagramId, currentDslContent, onDiagramUpdated }: ChatPanelProps) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [personas, setPersonas] = useState<AiPersonaDto[]>([]);
  const [personaId, setPersonaId] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // canvas-wuc: checked client-side before the user can even start typing, not just surfaced as a
  // 503 after a send attempt. `null` while unknown — the composer stays enabled during that brief
  // window rather than flashing disabled-then-enabled on every panel open.
  const [aiStatus, setAiStatus] = useState<AiSettingsDto | null>(null);

  useEffect(() => {
    api.listAiPersonas().then(({ personas }) => setPersonas(personas));
  }, []);

  useEffect(() => {
    api
      .getAiStatus()
      .then(setAiStatus)
      .catch(() => {
        // Unreachable/erroring is treated the same as "unknown" — the composer stays enabled and
        // simply surfaces its own error if actually used, same as before this bead.
      });
  }, []);

  const chatDisabled = aiStatus?.chatEnabled === false;

  useEffect(() => {
    setMessages([]);
    setHistoryLoaded(false);
    setPersonaId('');
    api
      .getChatMessages(diagramId)
      .then(({ messages: history }: { messages: ChatMessageDto[] }) => {
        setMessages(
          history.map((m) => ({
            role: m.role,
            content: m.role === 'assistant' ? formatAssistantContent(m.content, m.toolCalls) : m.content,
          })),
        );
      })
      .catch(() => {
        // A diagram that's never been chatted with (imported/hand-created) has no history —
        // the panel simply starts empty, not an error state.
      })
      .finally(() => setHistoryLoaded(true));
  }, [diagramId]);

  const handleSend = async () => {
    const message = input.trim();
    if (!message || chatDisabled) return;
    setError(null);
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setInput('');
    try {
      // personaId only has any effect on a diagram's first-ever message (FR-008a fixes it at
      // creation) — sent every time regardless, since the server already ignores it once a chat
      // exists rather than erroring, and tracking "is this the first message" client-side too
      // would just be a second copy of the same fact.
      const result = await api.sendChatMessage(diagramId, { message, currentDslContent, personaId: personaId || undefined });
      const content = formatAssistantContent(result.assistantMessage, result.toolCalls);
      setMessages((prev) => [...prev, { role: 'assistant', content }]);
      onDiagramUpdated(result.updatedDslContent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const personaGroups = groupPersonasByCategory(personas);
  // Only offered before the diagram's first message — FR-008a fixes the persona at creation, so
  // showing this once history exists would offer a choice that no longer does anything.
  const showPersonaPicker = historyLoaded && messages.length === 0 && personas.length > 0;

  return (
    <div className="panel" data-testid="chat-panel">
      <ul className="panel__body chat-messages" data-testid="chat-messages">
        {messages.length === 0 && !sending && (
          <li className="state" data-testid="chat-empty">
            <Icon name="sparkle" className="state__icon" />
            Describe a change to this diagram.
            <span className="meta">For example: &ldquo;add a shape called Review&rdquo;</span>
          </li>
        )}
        {messages.map((m, i) => (
          <li key={i} className={`chat-bubble chat-bubble--${m.role}`} data-testid={`chat-message-${m.role}`}>
            <span className="section-label">{m.role === 'user' ? 'You' : 'AI'}</span>
            <span>{m.content}</span>
          </li>
        ))}
        {sending && (
          <li className="chat-bubble chat-bubble--assistant chat-thinking" data-testid="chat-thinking" aria-live="polite">
            <span className="section-label">AI</span>
            <span className="chat-thinking__dots" aria-label="Thinking">
              <i />
              <i />
              <i />
            </span>
          </li>
        )}
      </ul>
      {chatDisabled && (
        <p className="state" data-testid="chat-disabled-notice">
          <Icon name="warning" className="state__icon" />
          {AI_CHAT_DISABLED_MESSAGE}
        </p>
      )}
      {aiStatus?.provider === 'mock' && (
        <p className="meta" data-testid="chat-mock-mode-notice">
          {AI_MOCK_MODE_MESSAGE}
        </p>
      )}
      {showPersonaPicker && (
        <div className="panel__footer">
          <div className="field">
            <label className="field__label" htmlFor="chat-persona-select">
              Persona for this diagram
            </label>
            <select
              id="chat-persona-select"
              data-testid="chat-persona-select"
              value={personaId}
              onChange={(e) => setPersonaId(e.target.value)}
            >
              <option value="">Default assistant (no persona)</option>
              {[...personaGroups.entries()].map(([category, categoryPersonas]) => (
                <optgroup key={category} label={category}>
                  {categoryPersonas.map((persona) => (
                    <option key={persona.id} value={persona.id}>
                      {persona.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className="panel__footer chat-composer">
        <textarea
          className="chat-composer__input"
          data-testid="chat-input"
          aria-label="Describe a change"
          placeholder="Describe a change…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={chatDisabled}
          rows={2}
        />
        <button
          type="button"
          className="btn btn--primary btn--compact"
          data-testid="chat-send"
          disabled={!input.trim() || sending || chatDisabled}
          onClick={handleSend}
        >
          <Icon name="send" />
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error && (
        <p role="alert" className="chat-error" data-testid="chat-error">
          <Icon name="warning" />
          {error}
          <button
            type="button"
            className="btn btn--tertiary btn--compact"
            onClick={handleSend}
            disabled={!input.trim() || chatDisabled}
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
