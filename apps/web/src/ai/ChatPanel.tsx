import { useEffect, useState } from 'react';
import { api, ApiError, type ChatMessageDto, type ToolCallOutcomeDto } from '../app/api';

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
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMessages([]);
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
      });
  }, [diagramId]);

  const handleSend = async () => {
    const message = input.trim();
    if (!message) return;
    setError(null);
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setInput('');
    try {
      const result = await api.sendChatMessage(diagramId, { message, currentDslContent });
      const content = formatAssistantContent(result.assistantMessage, result.toolCalls);
      setMessages((prev) => [...prev, { role: 'assistant', content }]);
      onDiagramUpdated(result.updatedDslContent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="chat-panel">
      <h3>AI Chat</h3>
      <ul data-testid="chat-messages">
        {messages.map((m, i) => (
          <li key={i} data-testid={`chat-message-${m.role}`}>
            <strong>{m.role === 'user' ? 'You' : 'AI'}:</strong> {m.content}
          </li>
        ))}
      </ul>
      <textarea
        data-testid="chat-input"
        aria-label="Describe a change"
        placeholder="Describe a change…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={2}
        cols={50}
      />
      <button type="button" data-testid="chat-send" disabled={!input.trim() || sending} onClick={handleSend}>
        {sending ? 'Sending…' : 'Send'}
      </button>
      {error && (
        <p role="alert" data-testid="chat-error">
          {error}
        </p>
      )}
    </div>
  );
}
