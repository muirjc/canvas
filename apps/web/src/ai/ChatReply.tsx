import type { ToolCallOutcomeDto } from '../app/api';
import { ChatMarkdown } from './chat-markdown';

/**
 * canvas-rfv: an assistant reply -- its text formatted (ChatMarkdown), then what it did to the
 * diagram as a separate note: how many edits applied, and each one that couldn't be, with the
 * tool's own reason (FR-014). Those reasons used to be appended to the reply text with a space,
 * reading as part of the AI's sentence.
 */
export function ChatReply({ text, toolCalls }: { text: string; toolCalls?: ToolCallOutcomeDto[] | null }) {
  const calls = toolCalls ?? [];
  const applied = calls.filter((c) => c.applied).length;
  const failed = calls.filter((c) => !c.applied && c.reason);
  return (
    <>
      {text && <ChatMarkdown text={text} />}
      {(applied > 0 || failed.length > 0) && (
        <div className="chat-edits" data-testid="chat-edits">
          {applied > 0 && (
            <p className="chat-edits__applied" data-testid="chat-edits-applied">
              {applied === 1 ? '1 change made to the diagram' : `${applied} changes made to the diagram`}
            </p>
          )}
          {failed.length > 0 && (
            <ul className="chat-edits__failed" aria-label="Changes that couldn't be made">
              {failed.map((c, i) => (
                <li key={i} data-testid="chat-edits-failed">
                  Couldn&rsquo;t make a change: {c.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
