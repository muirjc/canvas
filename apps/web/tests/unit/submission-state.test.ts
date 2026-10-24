import { describe, expect, it } from 'vitest';
import type { SubmissionDto, SubmissionStatusDto } from '../../src/app/api';
import { deriveChip, deriveSubmitButton, isSubmitVisible, previewPath } from '../../src/app/submission-state';

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
