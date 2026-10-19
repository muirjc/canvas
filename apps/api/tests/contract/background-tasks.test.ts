import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainBackgroundTasks, runInBackground } from '../../src/background/tasks.js';
import { buildTestApp, closeTestDb, resetDatabase } from '../helpers/setup.js';

/**
 * canvas-yrp: publishing/updating a standard re-checks every diagram of its type in the background
 * without holding up the response. Nothing waited for that work, so in CI it could still be
 * running when the next test's resetDatabase() TRUNCATEd the same tables -- a Postgres deadlock
 * (40P01) reported against an unrelated test. Background work is now tracked, and resetDatabase()
 * and app.close() wait for it.
 */
describe('background tasks are tracked and drained (canvas-yrp)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('drainBackgroundTasks waits for every running task, including ones started while draining', async () => {
    const finished: string[] = [];
    runInBackground(async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished.push('first');
      runInBackground(async () => {
        await new Promise((r) => setTimeout(r, 50));
        finished.push('chained');
      }, () => {});
    }, () => {});
    await drainBackgroundTasks();
    expect(finished).toEqual(['first', 'chained']);
  });

  it('a failing task reports through its error handler and never rejects the drain', async () => {
    const errors: unknown[] = [];
    runInBackground(async () => {
      throw new Error('boom');
    }, (error) => errors.push(error));
    await expect(drainBackgroundTasks()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('resetDatabase waits for background work before it truncates', async () => {
    let taskDone = false;
    runInBackground(async () => {
      await new Promise((r) => setTimeout(r, 150));
      taskDone = true;
    }, () => {});
    await resetDatabase();
    expect(taskDone).toBe(true);
  });

  it('app.close waits for background work', async () => {
    let taskDone = false;
    runInBackground(async () => {
      await new Promise((r) => setTimeout(r, 150));
      taskDone = true;
    }, () => {});
    await app.close();
    expect(taskDone).toBe(true);
  });
});
