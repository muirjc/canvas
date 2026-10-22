import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, generateOneTimePassword, MAX_PASSWORD_LENGTH } from '../../src/auth/password-policy.js';

describe('checkPasswordPolicy', () => {
  it('accepts a 12+ character password with no composition rules', () => {
    expect(checkPasswordPolicy('correct horse battery')).toBeNull();
    expect(checkPasswordPolicy('abcdefghijkl')).toBeNull();
  });

  it('rejects fewer than 12 characters', () => {
    expect(checkPasswordPolicy('shortpass11')).toMatch(/at least 12/);
    expect(checkPasswordPolicy('')).toMatch(/at least 12/);
  });

  it('rejects more than the maximum length', () => {
    expect(checkPasswordPolicy('ab'.repeat(MAX_PASSWORD_LENGTH))).toMatch(/at most/);
    expect(checkPasswordPolicy('a1'.repeat(MAX_PASSWORD_LENGTH / 2))).toBeNull();
  });

  it('rejects common passwords case-insensitively', () => {
    expect(checkPasswordPolicy('PasswordPassword')).toMatch(/too common/);
    expect(checkPasswordPolicy('123456789012')).toMatch(/too common/);
  });

  it('rejects a single repeated character', () => {
    expect(checkPasswordPolicy('zzzzzzzzzzzzzz')).toMatch(/too common/);
  });

  it('rejects a password containing the email local part (case-insensitive)', () => {
    expect(checkPasswordPolicy('xx-Jmuir-xx-yy', { email: 'JMuir@example.com' })).toMatch(/email/);
  });

  it('ignores email local parts shorter than 4 characters', () => {
    expect(checkPasswordPolicy('xx-abc-xx-yyyy', { email: 'abc@example.com' })).toBeNull();
  });
});

describe('generateOneTimePassword', () => {
  it('matches the xxxx-xxxx-xxxx-xxxx format without ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOneTimePassword()).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{4}(-[a-km-zA-HJ-NP-Z2-9]{4}){3}$/);
    }
  });

  it('always passes the policy and is not repeated', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const pw = generateOneTimePassword();
      expect(checkPasswordPolicy(pw, { email: 'someone@example.com' })).toBeNull();
      seen.add(pw);
    }
    expect(seen.size).toBe(50);
  });
});
