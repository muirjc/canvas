/**
 * canvas-yrp: work the API starts without holding up a response (e.g. re-checking every diagram
 * after a standard is published) is registered here, so it can be waited for before the process
 * closes its database connections and before a test resets the database.
 *
 * Untracked, such work outlived the request that started it: in CI it was still running when the
 * next test TRUNCATEd the same tables, and Postgres reported a deadlock (40P01) against an
 * unrelated test.
 */
const inFlight = new Set<Promise<void>>();

/**
 * Starts `task` in the background. `onError` receives any failure -- the task's promise is never
 * left unhandled, since an unhandled rejection terminates a Node process by default.
 */
export function runInBackground(task: () => Promise<unknown>, onError: (error: unknown) => void): void {
  const running: Promise<void> = Promise.resolve()
    .then(task)
    .then(
      () => undefined,
      (error: unknown) => onError(error),
    )
    .finally(() => inFlight.delete(running));
  inFlight.add(running);
}

/** Resolves once no background task is running, including any started while waiting. */
export async function drainBackgroundTasks(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}
