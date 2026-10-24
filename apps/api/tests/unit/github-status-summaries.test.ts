import { describe, expect, it } from 'vitest';
import { summarizeChecks, summarizeReviews } from '../../src/github/status-sync.service.js';
import type { ReviewSummary } from '../../src/github/github-client.js';

/** canvas-3s5.2: how reviews and checks collapse into the one state the editor shows. */
const review = (login: string, state: ReviewSummary['state']): ReviewSummary => ({ login, state, submittedAt: null });
const check = (name: string, state: string) => ({ name, state, url: null });

describe('summarizeReviews', () => {
  it('no reviews and no requests: none', () => {
    expect(summarizeReviews([], [])).toEqual({ state: 'none', latest: [] });
  });

  it('only comments or pending reviews are not a decision', () => {
    expect(summarizeReviews([review('a', 'COMMENTED'), review('b', 'PENDING')], []).state).toBe('none');
  });

  it('an approval stands after a later comment from the same reviewer', () => {
    expect(summarizeReviews([review('a', 'APPROVED'), review('a', 'COMMENTED')], [])).toEqual({ state: 'approved', latest: [{ login: 'a', state: 'APPROVED' }] });
  });

  it('a reviewer\'s latest decision replaces their earlier one, in either direction', () => {
    expect(summarizeReviews([review('a', 'APPROVED'), review('a', 'CHANGES_REQUESTED')], []).state).toBe('changes_requested');
    expect(summarizeReviews([review('a', 'CHANGES_REQUESTED'), review('a', 'APPROVED')], []).state).toBe('approved');
  });

  it('one reviewer requesting changes beats another approving', () => {
    expect(summarizeReviews([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')], []).state).toBe('changes_requested');
  });

  it('a dismissed review is dropped from the decisions', () => {
    expect(summarizeReviews([review('a', 'CHANGES_REQUESTED'), review('a', 'DISMISSED')], [])).toEqual({ state: 'none', latest: [] });
    expect(summarizeReviews([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED'), review('b', 'DISMISSED')], []).state).toBe('approved');
  });

  it('an outstanding request is pending, even with an approval, but changes requested still wins', () => {
    expect(summarizeReviews([review('a', 'APPROVED')], ['carl']).state).toBe('pending');
    expect(summarizeReviews([], ['carl']).state).toBe('pending');
    expect(summarizeReviews([review('a', 'CHANGES_REQUESTED')], ['carl']).state).toBe('changes_requested');
  });
});

describe('summarizeChecks', () => {
  it('none when there are no checks', () => {
    expect(summarizeChecks([])).toBe('none');
  });

  it('failure beats pending beats success', () => {
    expect(summarizeChecks([check('a', 'success'), check('b', 'pending'), check('c', 'failure')])).toBe('failure');
    expect(summarizeChecks([check('a', 'success'), check('b', 'pending')])).toBe('pending');
    expect(summarizeChecks([check('a', 'success'), check('b', 'success')])).toBe('success');
  });

  it('skipped and neutral are not failures or pending', () => {
    expect(summarizeChecks([check('a', 'skipped'), check('b', 'neutral')])).toBe('success');
  });
});
