import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type AiPersonaDto,
  type DiagramDto,
  type DiagramTypeDto,
  type ToolCallOutcomeDto,
} from '../app/api';
import { Modal } from '../ui/Modal';
import { groupPersonasByCategory } from './persona-grouping';

export interface CreateViaChatDialogProps {
  projectId: string;
  /** `openChat`: open the editor on the Chat tab -- the AI asked follow-up questions, or replied with
   *  text alongside the drawing (assumptions, open questions, next steps) that would otherwise sit
   *  unseen behind the DSL tab. */
  onCreated: (diagram: DiagramDto, options: { openChat: boolean }) => void;
  onCancel: () => void;
}

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** canvas-ltm: sent by "Just draw it" so a user is never stuck answering questions. */
export const DRAW_NOW_MESSAGE =
  'Please go ahead and draw the diagram now, using your best assumptions for anything still unclear.';

/** A reply "drew" when at least one tool call actually changed the diagram; anything else (a
 *  text-only reply) means the AI is asking or waiting, so the conversation stays in the dialog. */
function drewSomething(toolCalls: ToolCallOutcomeDto[]): boolean {
  return toolCalls.some((tc) => tc.applied);
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

/**
 * "Create via AI Chat" entry point (User Story 1, FR-005): pick a persona and diagram type,
 * describe the diagram, and get back a diagram populated by the AI.
 *
 * canvas-ltm: the AI may answer with follow-up questions instead of drawing (persona prompts ask
 * it to when a request is underspecified). The dialog then becomes a short conversation; the
 * editor only opens once a reply actually draws something, and the drawn diagram is saved before
 * it opens. The exchange is the diagram's ordinary chat history (persisted per turn by the chat
 * API), so it continues in the editor's Chat tab. Cancelling before anything is drawn deletes the
 * empty diagram created to hold the conversation.
 */
export function CreateViaChatDialog({ projectId, onCreated, onCancel }: CreateViaChatDialogProps) {
  const [personas, setPersonas] = useState<AiPersonaDto[]>([]);
  const [personaId, setPersonaId] = useState('');
  const [diagramTypes, setDiagramTypes] = useState<DiagramTypeDto[]>([]);
  const [diagramTypeId, setDiagramTypeId] = useState('flowchart');
  const [name, setName] = useState('Untitled Diagram');
  const [description, setDescription] = useState('');
  const [answer, setAnswer] = useState('');
  // The diagram exists from the first send onward; the conversation is keyed to it.
  const [diagram, setDiagram] = useState<DiagramDto | null>(null);
  const [dslContent, setDslContent] = useState('');
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last message that failed to send, so Retry can resend it.
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  // Set once a reply has drawn: only the save remains (Retry re-attempts just that).
  const [drawnDsl, setDrawnDsl] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  const persona = personas.find((p) => p.id === personaId);
  const conversing = transcript.length > 0;

  useEffect(() => {
    api.listAiPersonas().then(({ personas }) => setPersonas(personas));
  }, []);

  // Diagram types relevant to the chosen persona's architect category (Constitution III) --
  // persona categories and diagram-type persona tags share the same four values.
  useEffect(() => {
    let cancelled = false;
    api
      .listDiagramTypes(persona?.category)
      .then(({ diagramTypes }) => {
        if (cancelled) return;
        setDiagramTypes(diagramTypes);
        setDiagramTypeId((current) =>
          diagramTypes.some((t) => t.id === current)
            ? current
            : (diagramTypes.find((t) => t.id === 'flowchart') ?? diagramTypes[0])?.id ?? '',
        );
      })
      .catch(() => {
        if (!cancelled) setDiagramTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [persona?.category]);

  useEffect(() => {
    if (conversing && !busy) answerRef.current?.focus();
  }, [conversing, busy, transcript.length]);

  const finish = async (target: DiagramDto, finalDsl: string, hadConversation: boolean) => {
    // Saved here rather than left to the editor: the editor treats its opening DSL as the saved
    // baseline, so an unsaved AI-drawn diagram would otherwise be silently lost on navigation.
    const { diagram: saved } = await api.saveDiagram(target.id, finalDsl);
    onCreated(saved, { openChat: hadConversation });
  };

  /** Sends one message in the conversation, creating the diagram first if this is the opening one. */
  const send = async (message: string) => {
    setError(null);
    setBusy(true);
    setPendingMessage(message);
    let target = diagram;
    try {
      let currentDsl = dslContent;
      if (!target) {
        const { diagram: created } = await api.createDiagram(projectId, { name, diagramTypeId });
        target = created;
        currentDsl = created.dslContent;
        setDiagram(created);
        setDslContent(created.dslContent);
      }
      setTranscript((t) => [...t, { role: 'user', content: message }]);
      const result = await api.sendChatMessage(target.id, {
        message,
        currentDslContent: currentDsl,
        // Fixed by the server at the chat's first message; harmless on later ones.
        personaId,
      });
      setDslContent(result.updatedDslContent);
      setPendingMessage(null);
      if (drewSomething(result.toolCalls)) {
        setDrawnDsl(result.updatedDslContent);
        // Open on Chat whenever there's something to read there: a prior Q&A, or the AI's own
        // write-up of what it drew (persona prompts typically end with assumptions and open questions).
        await finish(target, result.updatedDslContent, transcript.length > 0 || Boolean(result.assistantMessage?.trim()));
        return;
      }
      setTranscript((t) => [...t, { role: 'assistant', content: result.assistantMessage || 'Could you tell me more?' }]);
      setAnswer('');
    } catch (err) {
      // Drop the optimistic user message if it never got an answer, so Retry doesn't duplicate it.
      setTranscript((t) => (t.length > 0 && t[t.length - 1].role === 'user' && t[t.length - 1].content === message ? t.slice(0, -1) : t));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (drawnDsl !== null && diagram) {
      setError(null);
      setBusy(true);
      try {
        await finish(diagram, drawnDsl, transcript.length > 0);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (pendingMessage) await send(pendingMessage);
  };

  const cancel = async () => {
    // The diagram only existed to hold this conversation; nothing was drawn, so remove it rather
    // than leave an empty "Untitled Diagram" behind. Best effort -- cancelling must never fail.
    if (diagram && drawnDsl === null) {
      try {
        await api.deleteDiagram(diagram.id);
      } catch {
        /* the empty diagram remains; the user can delete it from the project browser */
      }
    }
    onCancel();
  };

  const groups = groupPersonasByCategory(personas);
  const typesByFamily = new Map<string, DiagramTypeDto[]>();
  for (const t of diagramTypes) typesByFamily.set(t.dslFamily, [...(typesByFamily.get(t.dslFamily) ?? []), t]);

  return (
    <Modal
      label="Create via AI Chat"
      wide
      onClose={() => void cancel()}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="ai-create-cancel" onClick={() => void cancel()}>
            Cancel
          </button>
          {error && (pendingMessage || drawnDsl !== null) && (
            <button type="button" className="btn btn--secondary" data-testid="ai-create-retry" disabled={busy} onClick={() => void retry()}>
              Retry
            </button>
          )}
          {conversing ? (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="ai-create-draw-now"
                disabled={busy}
                onClick={() => void send(DRAW_NOW_MESSAGE)}
              >
                Just draw it
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="ai-create-answer-send"
                disabled={!answer.trim() || busy}
                onClick={() => void send(answer.trim())}
              >
                {busy ? 'Thinking…' : 'Send answer'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              data-testid="ai-create-confirm"
              disabled={!personaId || !diagramTypeId || !description.trim() || busy}
              onClick={() => void send(description.trim())}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          )}
        </>
      }
    >
      {!conversing ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor="ai-create-name">
              Name
            </label>
            <input id="ai-create-name" data-testid="ai-create-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ai-create-persona">
              Persona
            </label>
            <select id="ai-create-persona" data-testid="ai-create-persona" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              <option value="" disabled>
                Select a persona…
              </option>
              {[...groups.entries()].map(([category, categoryPersonas]) => (
                <optgroup key={category} label={category}>
                  {categoryPersonas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ai-create-type">
              Diagram type
            </label>
            <select
              id="ai-create-type"
              data-testid="ai-create-type"
              value={diagramTypeId}
              onChange={(e) => setDiagramTypeId(e.target.value)}
            >
              {[...typesByFamily.entries()].map(([family, types]) => (
                <optgroup key={family} label={family}>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ai-create-description">
              Describe the diagram you want
            </label>
            <textarea
              id="ai-create-description"
              data-testid="ai-create-description"
              aria-label="Describe the diagram you want"
              placeholder="Describe the diagram you want…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
            />
          </div>
        </>
      ) : (
        <>
          <p className="meta">
            The AI has a few questions before it draws {name ? `“${name}”` : 'your diagram'}. Answer them, or choose
            “Just draw it” to let it use its best assumptions.
          </p>
          <ul className="chat-messages create-chat__transcript" data-testid="ai-create-transcript" aria-live="polite">
            {transcript.map((m, i) => (
              <li key={i} className={`chat-bubble chat-bubble--${m.role}`} data-testid={`create-chat-${m.role}`}>
                <span className="section-label">{m.role === 'user' ? 'You' : 'AI'}</span>
                <span>{m.content}</span>
              </li>
            ))}
            {busy && (
              <li className="chat-bubble chat-bubble--assistant chat-thinking" data-testid="create-chat-thinking">
                <span className="section-label">AI</span>
                <span className="chat-thinking__dots" aria-label="Thinking">
                  <i />
                  <i />
                  <i />
                </span>
              </li>
            )}
          </ul>
          <div className="field">
            <label className="field__label" htmlFor="ai-create-answer">
              Your answer
            </label>
            <textarea
              id="ai-create-answer"
              ref={answerRef}
              data-testid="ai-create-answer"
              value={answer}
              disabled={busy}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && answer.trim() && !busy) {
                  e.preventDefault();
                  void send(answer.trim());
                }
              }}
              rows={3}
            />
          </div>
        </>
      )}
      {error && (
        <p role="alert" data-testid="ai-create-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
