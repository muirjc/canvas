import { describe, expect, it } from 'vitest';
import type { SubmissionDto, SubmissionStatusDto } from '../../src/app/api';
import { deriveBadge, deriveChip, deriveSubmitButton, isApprovalTabVisible, isSubmitVisible, previewPath, relativeTime, shouldPoll } from '../../src/app/submission-state';

const pr = (over: Partial<SubmissionDto> = {}): SubmissionDto => ({
  id: 's1', state: 'open', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', repoFullName: 'o/r', baseBranch: 'main',
  branch: 'canvas/x', path: 'a/b', submittedVersionSequence: 3, submittedBy: null, firstSubmittedAt: '', lastSubmittedAt: '',
  reviewState: null, checksState: null, mergedAt: null, mergedBy: null, closedAt: null, ...over,
});
const status = (over: Partial<SubmissionStatusDto> = {}): SubmissionStatusDto => ({
  enabled: true, link: { repoFullName: 'o/r', folder: 'a', baseBranch: 'main' }, current: null, changesSinceSubmitting: false,
  canSubmit: { allowed: true, reason: null, mustFixCount: 0, warningCount: 0 }, ...over,
});

describe('deriveChip', () => {
  it('covers each state', () => {
    expect(deriveChip(status()).kind).toBe('not-submitted');
    expect(deriveChip(status({ current: pr() })).label).toBe('In review · PR #7');
    expect(deriveChip(status({ current: pr(), changesSinceSubmitting: true })).kind).toBe('changed');
    expect(deriveChip(status({ current: pr({ state: 'merged' }) })).label).toBe('Approved (version 3)');
    expect(deriveChip(status({ current: pr({ state: 'closed' }) })).kind).toBe('rejected');
  });
});

describe('deriveSubmitButton', () => {
  it('is enabled when allowed and saved', () => {
    expect(deriveSubmitButton(status(), false)).toMatchObject({ label: 'Submit for approval', disabled: false });
  });
  it('relabels for an open PR', () => {
    expect(deriveSubmitButton(status({ current: pr() }), false)).toMatchObject({ label: 'Push update to PR #7', updatesOpenPr: true });
  });
  it('explains each block', () => {
    expect(deriveSubmitButton(status(), true).reason).toMatch(/Save/);
    const blocked = status({ canSubmit: { allowed: false, reason: 'must_fix', mustFixCount: 2, warningCount: 0 } });
    expect(deriveSubmitButton(blocked, false).reason).toMatch(/2 must-fix issues.*Issues tab/);
    const noEdit = status({ canSubmit: { allowed: false, reason: 'no_edit_access', mustFixCount: 0, warningCount: 0 } });
    expect(deriveSubmitButton(noEdit, false).reason).toMatch(/edit access/);
  });
});

describe('visibility and preview', () => {
  it('hides when disabled or unlinked', () => {
    expect(isSubmitVisible(null)).toBe(false);
    expect(isSubmitVisible(status({ enabled: false }))).toBe(false);
    expect(isSubmitVisible(status({ link: null }))).toBe(false);
    expect(isSubmitVisible(status())).toBe(true);
  });
  it('previews the path', () => {
    expect(previewPath('/architecture/diagrams/')).toBe('architecture/diagrams/<diagram-name>/README.md');
    expect(previewPath('')).toBe('<folder>/<diagram-name>/README.md');
  });
});

describe('phase 2 chip', () => {
  it('summarises review and check state', () => {
    expect(deriveChip(status({ current: pr({ checksState: 'failure' }) })).label).toBe('In review · PR #7 · checks failing');
    expect(deriveChip(status({ current: pr({ reviewState: 'changes_requested', checksState: 'success' }) })).label).toBe(
      'In review · PR #7 · changes requested · checks passing',
    );
    expect(deriveChip(status({ current: pr({ reviewState: 'approved', checksState: 'success' }) })).label).toBe(
      'In review · PR #7 · approved, not merged',
    );
  });
  it('shows withdrawn ahead of closed', () => {
    expect(deriveChip(status({ current: pr({ state: 'closed', withdrawnAt: '2026-01-01' }) })).kind).toBe('withdrawn');
  });
});

describe('deriveBadge', () => {
  const b = { state: 'open' as const, prNumber: 1, prUrl: null, reviewState: null, checksState: null, submittedVersionSequence: 4, changesSinceSubmitting: false, withdrawn: false };
  it('maps each state', () => {
    expect(deriveBadge(b).label).toBe('In review');
    expect(deriveBadge({ ...b, changesSinceSubmitting: true }).label).toBe('Changes since submitting');
    expect(deriveBadge({ ...b, state: 'merged' }).label).toBe('Approved v4');
    expect(deriveBadge({ ...b, state: 'closed' }).label).toBe('Rejected');
    expect(deriveBadge({ ...b, state: 'closed', withdrawn: true }).label).toBe('Withdrawn');
  });
});

describe('polling and tab visibility', () => {
  it('polls only while open', () => {
    expect(shouldPoll(status({ current: pr() }))).toBe(true);
    expect(shouldPoll(status({ current: pr({ state: 'merged' }) }))).toBe(false);
    expect(shouldPoll(status({ current: pr({ withdrawnAt: 'x' }) }))).toBe(false);
    expect(shouldPoll(status())).toBe(false);
    expect(shouldPoll(null)).toBe(false);
  });
  it('shows the Approval tab when linked or with history', () => {
    expect(isApprovalTabVisible(null)).toBe(false);
    expect(isApprovalTabVisible(status())).toBe(true);
    expect(isApprovalTabVisible(status({ enabled: false }))).toBe(false);
    expect(isApprovalTabVisible(status({ link: null }))).toBe(false);
    expect(isApprovalTabVisible(status({ link: null, current: pr() }))).toBe(true);
    expect(isApprovalTabVisible(status({ link: null }), true)).toBe(true);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  it('formats', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('2026-01-01T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-01-01T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2025-12-30T12:00:00Z', now)).toBe('2 days ago');
  });
});
