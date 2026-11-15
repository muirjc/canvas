import { useSyncExternalStore } from 'react';

/**
 * canvas-mqk0: once the server says Canvas is paused (a 503 with `code: "paused"`, or the live socket closing
 * with 4503), this tab stops talking to it: every API request fails here without a network call, and live
 * sessions stop. A tab left open on a paused environment would otherwise keep polling (notifications,
 * presence, the live socket's reconnects), and each request kept the app from scaling to zero.
 * Nothing un-pauses a tab but reloading it.
 */
let paused = false;
const listeners = new Set<() => void>();

export function isPaused(): boolean {
  return paused;
}

export function markPaused(): void {
  if (paused) return;
  paused = true;
  for (const listener of [...listeners]) listener();
}

export function onPaused(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests only. */
export function resetPausedForTests(): void {
  paused = false;
}

export function usePaused(): boolean {
  return useSyncExternalStore(onPaused, isPaused, isPaused);
}

/** Shown on every screen once the tab has stopped. */
export const PAUSED_MESSAGE =
  'Canvas has been paused by your admin, so this page has stopped talking to it. Anything you haven’t saved ' +
  'is still here until you close or reload the tab. Reload once Canvas is back.';
