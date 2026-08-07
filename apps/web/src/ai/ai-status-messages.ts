/**
 * canvas-wuc: shared between App.tsx's "Create with AI" button and ChatPanel.tsx's composer —
 * both gate on the same `AiSettingsDto` shape and must show identical wording for the same
 * underlying condition, rather than risk drifting into two different explanations of one fact.
 */
export const AI_CHAT_DISABLED_MESSAGE = 'AI chat is currently disabled by an administrator.';
export const AI_MOCK_MODE_MESSAGE = 'AI is running in test/mock mode — responses are simulated, not from a real AI model.';
